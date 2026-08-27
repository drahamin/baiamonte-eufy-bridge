from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta, timezone

from haffmpeg.camera import CameraMjpeg
from homeassistant.components import ffmpeg
from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.components.ffmpeg import DATA_FFMPEG
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import entity_platform
from homeassistant.helpers.aiohttp_client import async_aiohttp_proxy_stream
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import COORDINATOR, DOMAIN, Schema
from .coordinator import EufySecurityDataUpdateCoordinator
from .entity import EufySecurityEntity
from .eufy_security_api.camera import StreamProvider, StreamStatus
from .eufy_security_api.const import STREAM_TIMEOUT_SECONDS
from .eufy_security_api.exceptions import (
    FailedCommandException,
    WebSocketConnectionException,
)
from .eufy_security_api.metadata import Metadata
from .snapshot import is_valid_snapshot, product_snapshot_bytes

_LOGGER: logging.Logger = logging.getLogger(__package__)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Setup camera entities."""
    coordinator: EufySecurityDataUpdateCoordinator = hass.data[DOMAIN][COORDINATOR]
    product_properties = []
    for product in coordinator.devices.values():
        if product.is_camera is True:
            product_properties.append(
                Metadata.parse(product, {"name": "camera", "label": "Camera"})
            )

    entities = [
        EufySecurityCamera(coordinator, metadata) for metadata in product_properties
    ]
    coordinator.camera_snapshot_refreshers = [
        entity.async_refresh_stale_snapshot for entity in entities
    ]
    async_add_entities(entities)

    # register entity level services
    platform = entity_platform.async_get_current_platform()
    platform.async_register_entity_service("generate_image", {}, "_generate_image")
    platform.async_register_entity_service(
        "capture_snapshot", {}, "_capture_snapshot"
    )
    platform.async_register_entity_service(
        "start_p2p_livestream", {}, "_start_livestream"
    )
    platform.async_register_entity_service(
        "stop_p2p_livestream", {}, "_stop_livestream"
    )
    platform.async_register_entity_service(
        "start_rtsp_livestream", {}, "_start_rtsp_livestream"
    )
    platform.async_register_entity_service(
        "stop_rtsp_livestream", {}, "_stop_rtsp_livestream"
    )
    platform.async_register_entity_service(
        "ptz", Schema.PTZ_SERVICE_SCHEMA.value, "_async_ptz"
    )
    platform.async_register_entity_service("ptz_up", {}, "_async_ptz_up")
    platform.async_register_entity_service("ptz_down", {}, "_async_ptz_down")
    platform.async_register_entity_service("ptz_left", {}, "_async_ptz_left")
    platform.async_register_entity_service("ptz_right", {}, "_async_ptz_right")
    platform.async_register_entity_service("ptz_360", {}, "_async_ptz_360")
    platform.async_register_entity_service(
        "preset_position",
        Schema.PRESET_POSITION_SERVICE_SCHEMA.value,
        "_async_preset_position",
    )
    platform.async_register_entity_service(
        "save_preset_position",
        Schema.PRESET_POSITION_SERVICE_SCHEMA.value,
        "_async_save_preset_position",
    )
    platform.async_register_entity_service(
        "delete_preset_position",
        Schema.PRESET_POSITION_SERVICE_SCHEMA.value,
        "_async_delete_preset_position",
    )
    platform.async_register_entity_service("calibrate", {}, "_async_calibrate")

    platform.async_register_entity_service(
        "trigger_camera_alarm_with_duration",
        Schema.TRIGGER_ALARM_SERVICE_SCHEMA.value,
        "_async_alarm_trigger",
    )
    platform.async_register_entity_service("reset_alarm", {}, "_async_reset_alarm")
    platform.async_register_entity_service(
        "quick_response",
        Schema.QUICK_RESPONSE_SERVICE_SCHEMA.value,
        "_async_quick_response",
    )
    platform.async_register_entity_service("snooze", Schema.SNOOZE.value, "_snooze")


class EufySecurityCamera(Camera, EufySecurityEntity):
    """Base camera entity for integration"""

    def __init__(
        self, coordinator: EufySecurityDataUpdateCoordinator, metadata: Metadata
    ) -> None:
        Camera.__init__(self)
        EufySecurityEntity.__init__(self, coordinator, metadata)
        # An enabled HomeBase RTSP source is already a bounded local stream and
        # does not wake P2P. Let native HA cards use it. Cameras without RTSP stay
        # snapshot-only; the companion remains the owner of explicit P2P live view.
        self._attr_supported_features = (
            CameraEntityFeature.STREAM
            if self.product.is_rtsp_enabled and self.product.rtsp_stream_url
            else CameraEntityFeature(0)
        )
        self._attr_name = f"{self.product.name}"

        # camera image
        self._last_url = None
        self._last_image = product_snapshot_bytes(self.product)
        self.product.stream_stopped_listener = self._stop_hass_streaming
        self._scheduled_snapshot_lock = asyncio.Lock()
        # ffmpeg entities
        self.ffmpeg = self.coordinator.hass.data[DATA_FFMPEG]

    async def stream_source(self) -> str | None:
        """Return an already-started source without side effects during HA probes."""
        if self.product.is_rtsp_enabled and self.product.rtsp_stream_url:
            if self.product.stream_provider != StreamProvider.RTSP:
                self.product.set_stream_provider(StreamProvider.RTSP)
            return self.product.stream_url
        if self.is_streaming is False:
            return None
        return self.product.stream_url

    async def handle_async_mjpeg_stream(self, request):
        """Proxy one bounded live session and always release its Eufy source."""
        stream_source = await self.stream_source()
        if stream_source is None:
            return await super().handle_async_mjpeg_stream(request)
        stream = CameraMjpeg(self.ffmpeg.binary)
        try:
            async with asyncio.timeout(STREAM_TIMEOUT_SECONDS):
                await stream.open_camera(stream_source)
            return await async_aiohttp_proxy_stream(
                self.hass,
                request,
                await stream.get_reader(),
                self.ffmpeg.ffmpeg_stream_content_type,
            )
        except asyncio.TimeoutError as exc:
            raise ServiceValidationError(
                f"{self.product.model} opened P2P but delivered no playable media"
            ) from exc
        finally:
            await stream.close()
            if (
                self.product.stream_provider == StreamProvider.P2P
                and self.is_streaming
            ):
                try:
                    async with asyncio.timeout(8):
                        await self.product.stop_livestream()
                except (
                    asyncio.TimeoutError,
                    FailedCommandException,
                    WebSocketConnectionException,
                ):
                    self.product.stream_status = StreamStatus.IDLE
                    await self._stop_hass_streaming()
                    _LOGGER.warning(
                        "Camera proxy cleanup was not acknowledged; source released locally"
                    )

    async def async_create_stream(self):
        """Create HA playback only for a source the user already started."""
        if self.coordinator.config.no_stream_in_hass is True:
            return None
        if (
            self.is_streaming is False
            and not (self.product.is_rtsp_enabled and self.product.rtsp_stream_url)
        ):
            return None
        return await super().async_create_stream()

    async def _stop_hass_streaming(self):
        if self.stream is not None:
            await self.stream.stop()
            self.stream = None

    @property
    def is_streaming(self) -> bool:
        """Return true if the device is recording."""
        return self.product.stream_status == StreamStatus.STREAMING

    @property
    def available(self) -> bool:
        return self.coordinator.available

    def _require_command(self, command: str) -> None:
        if command not in self.product.commands:
            raise ServiceValidationError(
                f"{self.product.model} does not advertise the {command} capability"
            )

    @property
    def extra_state_attributes(self):
        """Expose privacy-safe capabilities for capability-driven dashboards.

        Serial numbers, stream URLs and raw bridge payloads deliberately stay out of
        the state attributes.  Consumers can use these booleans to avoid presenting
        controls that the connected camera does not advertise.
        """
        commands = set(self.product.commands or [])
        snapshot_updated_at = self.product.image_last_updated
        snapshot = product_snapshot_bytes(self.product, self._last_image)
        return {
            **super().extra_state_attributes,
            "model": self.product.model,
            "connected": bool(self.product.properties.get("connected", True)),
            "snapshot_available": snapshot is not None,
            "snapshot_updated_at": (
                snapshot_updated_at.isoformat() if snapshot_updated_at else None
            ),
            "snapshot_source": getattr(self.product, "snapshot_source", None),
            "capabilities": {
                "streaming": bool(
                    {"start_livestream", "stop_livestream"} & commands
                ),
                "rtsp": bool(
                    {"start_rtsp_livestream", "stop_rtsp_livestream"} & commands
                ),
                "ptz": "pan_and_tilt" in commands,
                "rotate_360": "pan_and_tilt" in commands,
                "presets": "preset_position" in commands,
                "save_presets": "save_preset_position" in commands,
                "delete_presets": "delete_preset_position" in commands,
                "calibrate": "calibrate" in commands,
                "quick_response": "quick_response" in commands,
                "alarm": bool(
                    {"trigger_alarm", "trigger_camera_alarm", "reset_alarm"} & commands
                ),
            },
            "stream_debug": self.product.stream_debug,
        }

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        """Return only the latest cached Eufy event frame.

        Camera cards and dashboards poll this method automatically.  They must never
        turn on a camera or create a P2P session; live video is an explicit user
        action handled by the livestream services.
        """
        snapshot = product_snapshot_bytes(self.product, self._last_image)
        if snapshot is not None:
            self._last_image = snapshot
        return self._last_image

    @callback
    def _handle_coordinator_update(self) -> None:
        """Keep a verified frame and invalidate failed frontend image responses."""
        snapshot = product_snapshot_bytes(self.product, self._last_image)
        if snapshot is not None and snapshot != self._last_image:
            self._last_image = snapshot
            # The camera proxy URL is tokenized. Rotate it as soon as the frame
            # changes so iOS/Android dashboards do not retain an earlier 404.
            self.async_update_token()
        super()._handle_coordinator_update()

    async def async_refresh_stale_snapshot(self, *, force: bool = False) -> bool:
        """Capture one bounded frame when requested or every source is stale."""
        updated_at = self.product.image_last_updated
        if (
            not force
            and updated_at is not None
            and datetime.now(timezone.utc) - updated_at < timedelta(hours=24)
        ):
            return False
        if self.is_streaming or not {
            "start_livestream",
            "stop_livestream",
        }.issubset(set(self.product.commands or [])):
            return False

        async with self._scheduled_snapshot_lock:
            started = False
            try:
                async with asyncio.timeout(STREAM_TIMEOUT_SECONDS):
                    started = await self.product.start_livestream()
                if not started:
                    return False

                frame = None
                deadline = asyncio.get_running_loop().time() + STREAM_TIMEOUT_SECONDS
                while frame is None and asyncio.get_running_loop().time() < deadline:
                    if self.is_streaming:
                        with contextlib.suppress(asyncio.TimeoutError):
                            frame = await asyncio.wait_for(
                                ffmpeg.async_get_image(
                                    self.hass,
                                    await self.stream_source(),
                                ),
                                timeout=4,
                            )
                    if frame is None:
                        await asyncio.sleep(0.5)
                if not is_valid_snapshot(frame):
                    return False
                self._last_image = frame
                self.product.properties["picture"] = {
                    "data": frame,
                    "type": {"mime": "image/jpeg"},
                }
                self.product.image_last_updated = datetime.now(timezone.utc)
                self.product.snapshot_source = (
                    "explicit_live_capture" if force else "scheduled_live_capture"
                )
                # Notify every camera/cache listener, rotate the camera token and
                # persist the verified frame. A direct entity state write does not
                # exercise the coordinator's durable snapshot cache.
                self.coordinator.async_update_listeners()
                return True
            except (
                asyncio.TimeoutError,
                FailedCommandException,
                WebSocketConnectionException,
            ):
                return False
            finally:
                if started:
                    try:
                        async with asyncio.timeout(8):
                            await self.product.stop_livestream()
                    except (
                        asyncio.TimeoutError,
                        FailedCommandException,
                        WebSocketConnectionException,
                    ):
                        self.product.stream_status = StreamStatus.IDLE
                        await self._stop_hass_streaming()

    async def _start_livestream(self) -> None:
        """Start a P2P source for the bounded camera proxy request."""
        if await self.product.start_livestream() is False:
            raise ServiceValidationError(
                f"{self.product.model} opened P2P but delivered no media"
            )
        self.async_write_ha_state()

    async def _stop_livestream(self) -> None:
        """stop byte based livestream on camera"""
        await self._stop_hass_streaming()
        await self.product.stop_livestream()
        self.async_write_ha_state()

    async def _start_rtsp_livestream(self) -> None:
        """Start the device RTSP source without creating an orphan HA worker."""
        if await self.product.start_rtsp_livestream() is False:
            raise ServiceValidationError(
                f"{self.product.model} did not deliver an RTSP stream"
            )
        self.async_write_ha_state()

    async def _stop_rtsp_livestream(self) -> None:
        """stop rtsp based livestream on camera"""
        await self._stop_hass_streaming()
        await self.product.stop_rtsp_livestream()
        self.async_write_ha_state()

    async def _async_alarm_trigger(self, duration: int = 10):
        """trigger alarm for a duration on camera"""
        await self.product.trigger_alarm(duration)

    async def _async_reset_alarm(self) -> None:
        """reset ongoing alarm"""
        await self.product.reset_alarm()

    async def async_turn_on(self) -> None:
        """Turn off camera."""
        if self.product.stream_provider == StreamProvider.RTSP:
            await self._start_rtsp_livestream()
        else:
            await self._start_livestream()

    async def async_turn_off(self) -> None:
        """Turn off camera."""
        if self.product.stream_provider == StreamProvider.RTSP:
            await self._stop_rtsp_livestream()
        else:
            await self._stop_livestream()

    async def _async_ptz(self, direction: str) -> None:
        self._require_command("pan_and_tilt")
        await self.product.ptz(direction)

    async def _async_ptz_up(self) -> None:
        self._require_command("pan_and_tilt")
        await self.product.ptz_up()

    async def _async_ptz_down(self) -> None:
        self._require_command("pan_and_tilt")
        await self.product.ptz_down()

    async def _async_ptz_left(self) -> None:
        self._require_command("pan_and_tilt")
        await self.product.ptz_left()

    async def _async_ptz_right(self) -> None:
        self._require_command("pan_and_tilt")
        await self.product.ptz_right()

    async def _async_ptz_360(self) -> None:
        self._require_command("pan_and_tilt")
        await self.product.ptz_360()

    async def _async_preset_position(self, position: int) -> None:
        self._require_command("preset_position")
        await self.product.preset_position(position)

    async def _async_save_preset_position(self, position: int) -> None:
        self._require_command("save_preset_position")
        await self.product.save_preset_position(position)

    async def _async_delete_preset_position(self, position: int) -> None:
        self._require_command("delete_preset_position")
        await self.product.delete_preset_position(position)

    async def _async_calibrate(self) -> None:
        self._require_command("calibrate")
        await self.product.calibrate()

    async def _generate_image(self) -> None:
        await self.async_camera_image()

    async def _capture_snapshot(self) -> None:
        """Capture and persist one frame after an explicit user action."""
        if await self.async_refresh_stale_snapshot(force=True):
            return
        raise ServiceValidationError(
            f"{self.product.name} did not deliver a snapshot; "
            "its prior image was preserved"
        )

    async def _async_quick_response(self, voice_id: int) -> None:
        await self.product.quick_response(voice_id)

    async def _snooze(
        self,
        snooze_time: int,
        snooze_chime: bool,
        snooze_motion: bool,
        snooze_homebase: bool,
    ) -> None:
        await self.product.snooze(
            snooze_time, snooze_chime, snooze_motion, snooze_homebase
        )
