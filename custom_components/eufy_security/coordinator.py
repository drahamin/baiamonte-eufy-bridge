"""Coordinate Baiamonte Eufy Security bridge state."""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import shutil
import tempfile
from urllib.parse import urlparse
from datetime import datetime, timedelta, timezone

import aiohttp
from homeassistant.components.persistent_notification import async_create
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import aiohttp_client
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DISCONNECTED, DOMAIN
from .eufy_security_api.api_client import ApiClient
from .eufy_security_api.exceptions import (
    CaptchaRequiredException,
    DriverNotConnectedException,
    MultiFactorCodeRequiredException,
    WebSocketConnectionException,
)
from .model import Config
from .evidence import (
    cloud_ai_details,
    event_merge_key,
    local_ai_details,
    normalize_cloud_event,
    normalize_local_event,
)

_LOGGER: logging.Logger = logging.getLogger(__package__)


class EufySecurityDataUpdateCoordinator(DataUpdateCoordinator):
    """Data update coordinator for integration"""

    def __init__(self, hass: HomeAssistant, config_entry: ConfigEntry) -> None:
        self.config: Config = Config.parse(config_entry)
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_method=self._update_local,
            update_interval=timedelta(seconds=self.config.sync_interval),
        )
        self._platforms = []
        self.data = {"bridge": None}
        self._session = aiohttp_client.async_get_clientsession(self.hass)
        self._api = ApiClient(self.config, self._session, self._on_error)
        self._reload_pending = False
        # Camera cards can request every thumbnail at the same time.  Eufy stations
        # do not tolerate parallel P2P setup well, so permit one opportunistic
        # snapshot capture for the whole account while the remaining cards return
        # their cached event image immediately.
        self.camera_snapshot_semaphore = asyncio.Semaphore(1)
        self.last_bridge_error: str | None = None
        self._evidence_records: dict[str, dict] = {}
        self._evidence_video_cache: dict[str, bytes] = {}

    async def initialize(self):
        """Initialize the integration"""
        try:
            async with asyncio.timeout(180):
                await self._api.connect()
                await self._refresh_bridge_status()
        except CaptchaRequiredException as exc:
            self.config.captcha_id = exc.captcha_id
            self.config.captcha_img = exc.captcha_img
            raise ConfigEntryAuthFailed() from exc
        except MultiFactorCodeRequiredException as exc:
            self.config.mfa_required = True
            raise ConfigEntryAuthFailed() from exc
        except DriverNotConnectedException as exc:
            raise ConfigEntryNotReady() from exc
        except WebSocketConnectionException as exc:
            raise ConfigEntryNotReady() from exc
        except asyncio.TimeoutError as exc:
            raise ConfigEntryNotReady(
                "Baiamonte eufy Bridge inventory did not finish within three minutes"
            ) from exc

    @property
    def platforms(self):
        """Initialized platforms list"""
        return self._platforms

    @property
    def devices(self) -> dict:
        """get devices from API"""
        return self._api.devices

    @property
    def stations(self) -> dict:
        """get stations from API"""
        return self._api.stations

    async def set_mfa_and_connect(self, mfa_input: str):
        """set mfa and connect"""
        await self._api.set_mfa_and_connect(mfa_input)

    async def set_captcha_and_connect(self, captcha_id: str, captcha_input: str):
        """set captcha and connect"""
        await self._api.set_captcha_and_connect(captcha_id, captcha_input)

    async def send_message(self, message: str) -> None:
        """send message to websocket api"""
        await self._api.send_message(message)

    async def set_log_level(self, log_level: str) -> None:
        """set log level of websocket server"""
        await self._api.set_log_level(log_level)

    async def search_evidence(
        self,
        *,
        source: str = "hybrid",
        days: int = 1,
        max_results: int = 100,
        station_serial: str = "",
        device_serial: str = "",
    ) -> dict:
        """Search cloud-indexed and, where proven, local HomeBase records."""
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)
        events: list[dict] = []
        warnings: list[str] = []
        local_stations = []

        if source in {"hybrid", "cloud"}:
            try:
                raw = await self._api.get_history_events(
                    int(start.timestamp() * 1000),
                    int(end.timestamp() * 1000),
                    {
                        "stationSN": station_serial,
                        "deviceSN": device_serial,
                        "storageType": 0,
                    },
                    max_results,
                )
                for record in raw:
                    event = normalize_cloud_event(record)
                    event["ai"] = cloud_ai_details(record)
                    self._add_ai_image_urls(event)
                    self._remember_evidence(event["event_id"], "cloud", record)
                    events.append(event)
            except (WebSocketConnectionException, asyncio.TimeoutError) as exc:
                warnings.append(f"account_index: {type(exc).__name__}")

        if source in {"hybrid", "local"}:
            for station in self.stations.values():
                if station_serial and station.serial_no != station_serial:
                    continue
                if "database_query_local" not in (station.commands or []):
                    # Station command capabilities are legacy CommandName values; unlike device
                    # commands, schema 21 does not snake-case them.
                    if "stationDatabaseQueryLocal" not in (station.commands or []):
                        continue
                serial_numbers = [device_serial] if device_serial else [
                    device.serial_no
                    for device in self.devices.values()
                    if device.properties.get("stationSerialNumber") == station.serial_no
                ]
                if not serial_numbers:
                    continue
                local_stations.append(station.model)
                try:
                    raw = await station.database_query_local(
                        serial_numbers,
                        start.strftime("%Y%m%d"),
                        end.strftime("%Y%m%d"),
                    )
                    for record in raw:
                        event = normalize_local_event(record)
                        device = self.devices.get(record.get("device_sn"))
                        event["device_name"] = device.name if device else "Camera"
                        event["station_name"] = station.name
                        event["ai"] = local_ai_details(record)
                        self._add_ai_image_urls(event)
                        self._remember_evidence(event["event_id"], "local", record)
                        events.append(event)
                except (RuntimeError, ValueError, asyncio.TimeoutError) as exc:
                    warnings.append(f"{station.model}: {type(exc).__name__}")

        merged: dict[tuple, dict] = {}
        for event in events:
            key = event_merge_key(event)
            if key in merged:
                current = merged[key]
                current["source"] = "hybrid"
                current["ai_categories"] = sorted(
                    set(current.get("ai_categories", []))
                    | set(event.get("ai_categories", []))
                )
                current["has_thumbnail"] |= event.get("has_thumbnail", False)
                current["has_video"] |= event.get("has_video", False)
                current_ai = current.setdefault("ai", {})
                incoming_ai = event.get("ai", {})
                current_ai["categories"] = sorted(
                    set(current_ai.get("categories", []))
                    | set(incoming_ai.get("categories", []))
                )
                if incoming_ai.get("crops"):
                    current_ai["crops"] = incoming_ai["crops"]
                if incoming_ai.get("faces"):
                    current_ai["faces"] = incoming_ai["faces"]
            else:
                merged[key] = event
        result = sorted(
            merged.values(), key=lambda event: event.get("start") or "", reverse=True
        )[:max_results]
        for event in result:
            event_id = event["event_id"]
            if event.get("has_thumbnail"):
                event["thumbnail_url"] = f"/api/baiamonte_eufy/evidence/{event_id}/thumbnail"
            if event.get("has_video"):
                event["video_url"] = f"/api/baiamonte_eufy/evidence/{event_id}/video"
        return {
            "source": source,
            "window_days": days,
            "count": len(result),
            "local_homebase_models": sorted(set(local_stations)),
            "warnings": warnings,
            "events": result,
        }

    def _remember_evidence(self, event_id: str, source: str, record: dict) -> None:
        """Keep bounded raw lookup material in memory for protected media requests."""
        self._evidence_records[event_id] = {"source": source, "record": record}
        while len(self._evidence_records) > 500:
            self._evidence_records.pop(next(iter(self._evidence_records)))

    @staticmethod
    def _add_ai_image_urls(event: dict) -> None:
        """Add opaque protected image routes to AI face/crop descriptions."""
        details = event.get("ai", {})
        items = details.get("faces") or details.get("crops") or []
        for index, item in enumerate(items):
            if item.get("has_image"):
                item["image_url"] = (
                    f"/api/baiamonte_eufy/evidence/{event['event_id']}/ai/{index}"
                )

    def _evidence(self, event_id: str) -> tuple[str, dict]:
        cached = self._evidence_records.get(event_id)
        if cached is None:
            raise KeyError(event_id)
        return cached["source"], cached["record"]

    @staticmethod
    def _buffer_bytes(value) -> bytes:
        """Decode base64 text or a Node Buffer JSON object."""
        if isinstance(value, dict):
            if isinstance(value.get("data"), dict):
                value = value["data"]
            if isinstance(value.get("data"), list):
                return bytes(value["data"])
        if isinstance(value, str):
            try:
                return base64.b64decode(value, validate=True)
            except (ValueError, TypeError):
                return b""
        return b""

    async def evidence_thumbnail(self, event_id: str) -> tuple[bytes, str]:
        """Retrieve an event thumbnail through the authenticated bridge session."""
        source, record = self._evidence(event_id)
        if source == "cloud":
            inline = self._buffer_bytes(record.get("thumb_data"))
            if inline.startswith(b"\xff\xd8\xff"):
                return inline, "image/jpeg"
            if inline.startswith(b"\x89PNG\r\n\x1a\n"):
                return inline, "image/png"
            station_serial = record.get("station_sn")
            file = record.get("thumb_path")
        else:
            history = record.get("history") if isinstance(record.get("history"), dict) else record
            station_serial = record.get("station_sn") or history.get("station_sn")
            file = history.get("thumb_path")
        station = self.stations.get(station_serial)
        if station is None or not file:
            raise ValueError("This event has no retrievable HomeBase thumbnail")
        picture = await station.download_image(file)
        data = self._buffer_bytes(picture.get("data"))
        if not data:
            raise ValueError("HomeBase returned an empty thumbnail")
        image_type = picture.get("type") if isinstance(picture.get("type"), dict) else {}
        return data, image_type.get("mime") or "application/octet-stream"

    async def evidence_ai_image(self, event_id: str, index: int) -> tuple[bytes, str]:
        """Retrieve a face/crop image without disclosing its cloud or disk location."""
        source, record = self._evidence(event_id)
        if source == "local":
            pictures = record.get("picture") if isinstance(record.get("picture"), list) else []
            if index < 0 or index >= len(pictures):
                raise ValueError("AI crop does not exist")
            station_serial = record.get("station_sn")
            file = pictures[index].get("crop_path")
            station = self.stations.get(station_serial)
            if station is None or not file:
                raise ValueError("AI crop is not retrievable from this HomeBase")
            picture = await station.download_image(file)
            data = self._buffer_bytes(picture.get("data"))
            image_type = picture.get("type") if isinstance(picture.get("type"), dict) else {}
            if not data:
                raise ValueError("HomeBase returned an empty AI crop")
            return data, image_type.get("mime") or "application/octet-stream"

        faces = record.get("ai_faces") if isinstance(record.get("ai_faces"), list) else []
        if index < 0 or index >= len(faces):
            raise ValueError("AI face does not exist")
        source_url = faces[index].get("face_url")
        parsed = urlparse(source_url or "")
        hostname = (parsed.hostname or "").lower()
        trusted_suffixes = (".eufylife.com", ".eufy.com", ".anker.com", ".ankercs.com")
        if parsed.scheme != "https" or not any(
            hostname == suffix[1:] or hostname.endswith(suffix)
            for suffix in trusted_suffixes
        ):
            raise ValueError("Eufy did not provide a trusted face-image host")
        async with self._session.get(
            source_url,
            allow_redirects=False,
            timeout=aiohttp.ClientTimeout(total=20),
        ) as response:
            response.raise_for_status()
            if not response.content_type.startswith("image/"):
                raise ValueError("Eufy face endpoint did not return an image")
            if response.content_length and response.content_length > 10 * 1024 * 1024:
                raise ValueError("AI face image exceeds 10 MB limit")
            data = await response.read()
            if len(data) > 10 * 1024 * 1024:
                raise ValueError("AI face image exceeds 10 MB limit")
            return data, response.content_type or "application/octet-stream"

    async def evidence_video(self, event_id: str) -> bytes:
        """Download and remux an encrypted HomeBase recording for browser playback."""
        if event_id in self._evidence_video_cache:
            return self._evidence_video_cache[event_id]
        source, record = self._evidence(event_id)
        if source == "local":
            wrapper = record
            history = record.get("history") if isinstance(record.get("history"), dict) else record
            device_serial = wrapper.get("device_sn") or history.get("device_sn")
            path = history.get("storage_path")
            cipher_id = history.get("cipher_id")
        else:
            device_serial = record.get("device_sn")
            path = record.get("hevc_storage_path") or record.get("storage_path")
            cipher_id = record.get("cipher_id")
        camera = self.devices.get(device_serial)
        if camera is None or not path or not hasattr(camera, "download_recording"):
            raise ValueError("This event has no downloadable HomeBase recording")
        downloaded = await camera.download_recording(path, cipher_id)
        video = downloaded.get("video", b"")
        if not video:
            raise ValueError("HomeBase returned an empty recording")
        mp4 = await self._remux_recording(
            video, downloaded.get("audio", b""), downloaded.get("metadata", {})
        )
        self._evidence_video_cache[event_id] = mp4
        while len(self._evidence_video_cache) > 4:
            self._evidence_video_cache.pop(next(iter(self._evidence_video_cache)))
        return mp4

    async def _remux_recording(self, video: bytes, audio: bytes, metadata: dict) -> bytes:
        """Put the bridge's elementary streams into a browser-compatible MP4 container."""
        ffmpeg = await asyncio.to_thread(shutil.which, "ffmpeg")
        if ffmpeg is None:
            raise RuntimeError("Home Assistant ffmpeg is unavailable")
        codec = str(metadata.get("videoCodec") or "H264").upper()
        video_format = "hevc" if codec in {"H265", "HEVC"} else "h264"
        fps = str(max(1, min(int(metadata.get("videoFPS") or 15), 120)))
        audio_codec = str(metadata.get("audioCodec") or "").upper()
        directory = await asyncio.to_thread(
            tempfile.mkdtemp, prefix="baiamonte-eufy-", dir=self.hass.config.path(".storage")
        )
        video_file = os.path.join(directory, f"video.{video_format}")
        audio_file = os.path.join(directory, "audio.aac")
        output_file = os.path.join(directory, "recording.mp4")
        try:
            await asyncio.to_thread(self._write_bytes, video_file, video)
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                video_format,
                "-r",
                fps,
                "-i",
                video_file,
            ]
            if audio and audio_codec == "AAC":
                await asyncio.to_thread(self._write_bytes, audio_file, audio)
                command.extend(["-f", "aac", "-i", audio_file, "-c:a", "copy"])
            command.extend(["-c:v", "copy", "-movflags", "+faststart", output_file])
            process = await asyncio.create_subprocess_exec(
                *command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
            )
            _, stderr = await process.communicate()
            if process.returncode != 0:
                detail = stderr.decode(errors="replace")[-300:]
                raise RuntimeError(f"ffmpeg could not remux this recording: {detail}")
            return await asyncio.to_thread(self._read_bytes, output_file)
        finally:
            await asyncio.to_thread(shutil.rmtree, directory, True)

    @staticmethod
    def _write_bytes(path: str, value: bytes) -> None:
        with open(path, "wb") as stream:
            stream.write(value)

    @staticmethod
    def _read_bytes(path: str) -> bytes:
        with open(path, "rb") as stream:
            return stream.read()

    async def refresh_homebase_storage(self, station_serial: str = "") -> dict:
        """Request fresh read-only storage telemetry from compatible HomeBases."""
        refreshed = []
        for station in self.stations.values():
            if station_serial and station.serial_no != station_serial:
                continue
            if station.model not in {"T8030", "T9000"}:
                continue
            await self._api.get_storage_info(station.serial_no)
            refreshed.append(station.model)
        return {"requested": len(refreshed), "models": sorted(set(refreshed))}

    async def _update_local(self):
        try:
            _LOGGER.debug("coordinator - start update_local")
            await self._api.poll_refresh()
            await self._refresh_bridge_status()
            _LOGGER.debug("coordinator - complete update_local")
            return self.data
        except WebSocketConnectionException as exc:
            raise UpdateFailed(f"Error communicating with Add-on: {exc}") from exc

    async def disconnect(self):
        """disconnect from api"""
        await self._api.disconnect()
        self._api = None
        await self.async_shutdown()

    async def _refresh_bridge_status(self) -> None:
        """Read the bridge's redacted health and Mega catalog summary."""
        url = f"http://{self.config.host}:{self.config.dashboard_port}/api/status"
        try:
            async with self._session.get(
                url, timeout=aiohttp.ClientTimeout(total=20)
            ) as response:
                response.raise_for_status()
                self.data["bridge"] = await response.json()
                self.last_bridge_error = None
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            self.last_bridge_error = type(exc).__name__
            _LOGGER.debug(
                "Bridge dashboard diagnostics are unavailable: %s", type(exc).__name__
            )

    async def _async_reload(self, _):
        await asyncio.sleep(5)
        try:
            await self.hass.config_entries.async_reload(self.config.entry.entry_id)
        finally:
            self._reload_pending = False

    def _on_error(self, error):
        """raise notification on frontend when exception happens"""
        if self._reload_pending:
            return
        self._reload_pending = True
        async_create(
            self.hass,
            "Connection to Baiamonte eufy Bridge was interrupted; reconnecting in the background.",
            title="Baiamonte Eufy Security",
            notification_id="baiamonte_eufy_bridge_connection_error",
        )
        self.hass.bus.async_listen_once(DISCONNECTED, self._async_reload)
        self.hass.bus.async_fire(DISCONNECTED, None)

    @property
    def available(self) -> bool:
        return self._api is not None and self._api.available
