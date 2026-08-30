"""Coordinate Baiamonte Eufy Security bridge state."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import shutil
import tempfile
from urllib.parse import urlparse
from datetime import datetime, timedelta, timezone

import aiohttp
from homeassistant.components.persistent_notification import async_create
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState, Event, HomeAssistant, callback
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
    aic_ai_details,
    cloud_ai_details,
    event_merge_key,
    join_aic_event_data,
    local_ai_details,
    normalize_aic_event,
    normalize_cloud_event,
    normalize_local_event,
)
from .snapshot import disk_cache_source, is_valid_snapshot

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
        self.last_bridge_error: str | None = None
        self._evidence_records: dict[str, dict] = {}
        self._evidence_video_cache: dict[str, bytes] = {}
        self.camera_snapshot_refreshers = []
        self._daily_snapshot_task: asyncio.Task | None = None
        self._daily_snapshot_unsub = None
        self._snapshot_cache_task: asyncio.Task | None = None
        self._snapshot_cache_dirty = False
        self._snapshot_cache_dir = self.hass.config.path(
            ".storage", "baiamonte_eufy_snapshots"
        )

    async def initialize(self):
        """Initialize the integration"""
        try:
            async with asyncio.timeout(180):
                await self._api.connect()
                await self._refresh_bridge_status()
                await self._restore_snapshot_cache()
                self._schedule_snapshot_cache_write()
                if (
                    self._daily_snapshot_task is None
                    and self._daily_snapshot_unsub is None
                ):
                    if self.hass.state == CoreState.running:
                        self._start_daily_snapshot_task()
                    else:
                        # Do not create the long-lived sleeper during integration
                        # setup: HA waits for setup-created tasks before declaring
                        # startup complete.
                        self._daily_snapshot_unsub = (
                            self.hass.bus.async_listen_once(
                                EVENT_HOMEASSISTANT_STARTED,
                                self._async_home_assistant_started,
                            )
                        )
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

        if source in {"hybrid", "cloud", "latest"}:
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
            except Exception as exc:
                _LOGGER.warning(
                    "Account evidence index unavailable: %s", type(exc).__name__
                )
                warnings.append(f"account_index: {type(exc).__name__}")

        if source in {"hybrid", "local", "latest"}:
            semaphore = asyncio.Semaphore(1)

            async def query_station(station):
                if station_serial and station.serial_no != station_serial:
                    return [], None, None
                commands = set(station.commands or [])
                if {"database_query_aic_events", "stationDatabaseQueryAicEvents"} & commands:
                    try:
                        async with semaphore, asyncio.timeout(45):
                            raw_aic = await station.database_query_aic_events(
                                start.isoformat(), end.isoformat(), min(max_results, 200)
                            )
                        station_events = []
                        for record in join_aic_event_data(raw_aic):
                            record["station_sn"] = station.serial_no
                            raw_device_serial = record.get("device_sn")
                            device = self.devices.get(raw_device_serial)
                            if device is None and record.get("device_channel") is not None:
                                channel = record["device_channel"]
                                matches = [
                                    candidate
                                    for candidate in self.devices.values()
                                    if candidate.properties.get("stationSerialNumber") == station.serial_no
                                    and self._device_channel(candidate) == channel
                                ]
                                if len(matches) == 1:
                                    device = matches[0]
                                    raw_device_serial = device.serial_no
                                    record["device_sn"] = raw_device_serial
                            if device_serial and raw_device_serial != device_serial:
                                continue
                            event = normalize_aic_event(record)
                            if device is not None:
                                event["device_name"] = device.name
                            event["station_name"] = station.name
                            event["ai"] = aic_ai_details(record)
                            self._add_ai_image_urls(event)
                            self._remember_evidence(event["event_id"], "aic", record)
                            station_events.append(event)
                        return station_events, station.model, None
                    except (
                        RuntimeError,
                        ValueError,
                        WebSocketConnectionException,
                        asyncio.TimeoutError,
                    ) as exc:
                        return [], station.model, f"{station.model}: {type(exc).__name__}"
                    except Exception as exc:
                        _LOGGER.warning(
                            "HomeBase %s AIC evidence index unavailable: %s",
                            station.model,
                            type(exc).__name__,
                        )
                        return [], station.model, f"{station.model}: {type(exc).__name__}"
                if source == "latest":
                    return [], None, None
                if "database_query_local" not in (station.commands or []):
                    # Station command capabilities are legacy CommandName values; unlike device
                    # commands, schema 21 does not snake-case them.
                    if "stationDatabaseQueryLocal" not in (station.commands or []):
                        return [], None, None
                serial_numbers = [device_serial] if device_serial else [
                    device.serial_no
                    for device in self.devices.values()
                    if device.properties.get("stationSerialNumber") == station.serial_no
                ]
                if not serial_numbers:
                    return [], None, None
                try:
                    async with semaphore, asyncio.timeout(15):
                        raw = await station.database_query_local(
                            serial_numbers,
                            start.strftime("%Y%m%d"),
                            end.strftime("%Y%m%d"),
                        )
                    station_events = []
                    for record in raw:
                        event = normalize_local_event(record)
                        device = self.devices.get(record.get("device_sn"))
                        event["device_name"] = device.name if device else "Camera"
                        event["station_name"] = station.name
                        event["ai"] = local_ai_details(record)
                        self._add_ai_image_urls(event)
                        self._remember_evidence(event["event_id"], "local", record)
                        station_events.append(event)
                    return station_events, station.model, None
                except (
                    RuntimeError,
                    ValueError,
                    WebSocketConnectionException,
                    asyncio.TimeoutError,
                ) as exc:
                    return [], station.model, f"{station.model}: {type(exc).__name__}"
                except Exception as exc:
                    _LOGGER.warning(
                        "HomeBase %s evidence index unavailable: %s",
                        station.model,
                        type(exc).__name__,
                    )
                    return [], station.model, f"{station.model}: {type(exc).__name__}"

            tasks = [
                asyncio.create_task(query_station(station))
                for station in self.stations.values()
            ]
            done, pending = await asyncio.wait(tasks, timeout=45)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
                warnings.append(f"local_index: {len(pending)} endpoint timeout")
            for task in done:
                try:
                    station_events, station_model, warning = task.result()
                except asyncio.CancelledError:
                    continue
                except Exception as exc:
                    warnings.append(f"local_index: {type(exc).__name__}")
                    continue
                events.extend(station_events)
                if station_model:
                    local_stations.append(station_model)
                if warning:
                    warnings.append(warning)

        merged: dict[tuple, dict] = {}
        for event in events:
            key = event_merge_key(event)
            if key in merged:
                current = merged[key]
                priority = {"account_index": 0, "homebase_local": 1, "homebase_pro_aic": 2}
                if priority.get(event.get("source"), 0) > priority.get(current.get("source"), 0):
                    current, event = event, current
                    merged[key] = current
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
                if isinstance(incoming_ai.get("crops"), list) and incoming_ai["crops"]:
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

    async def _daily_snapshot_loop(self) -> None:
        """Refresh non-live snapshots daily without delaying Home Assistant startup."""
        try:
            # Let inventory settle, then use one bounded index query to populate
            # app-style event images. This path never starts a livestream.
            await asyncio.sleep(60)
            while True:
                try:
                    async with asyncio.timeout(10 * 60):
                        await self.refresh_latest_snapshots()
                except (asyncio.TimeoutError, RuntimeError, WebSocketConnectionException) as exc:
                    _LOGGER.warning(
                        "Daily non-live snapshot refresh was deferred: %s",
                        type(exc).__name__,
                    )
                await asyncio.sleep(24 * 60 * 60)
        except asyncio.CancelledError:
            return

    @callback
    def _async_home_assistant_started(self, _event: Event) -> None:
        """Start snapshot maintenance only after bootstrap has completed."""
        self._daily_snapshot_unsub = None
        self._start_daily_snapshot_task()

    @callback
    def _start_daily_snapshot_task(self) -> None:
        """Create the lifecycle-managed daily snapshot worker."""
        if self._daily_snapshot_task is None:
            self._daily_snapshot_task = self.hass.async_create_background_task(
                self._daily_snapshot_loop(),
                "baiamonte_eufy_daily_snapshot_refresh",
            )

    async def refresh_latest_snapshots(self) -> dict:
        """Select the newest cloud/HomeBase thumbnail for every matching camera."""
        # The account index includes event metadata for HomeBase-backed cameras
        # without opening dozens of local station database sessions in the
        # background. Full local history remains an explicit panel action.
        result = await self.search_evidence(source="latest", days=1, max_results=200)
        latest: dict[str, dict] = {}
        for event in result.get("events", []):
            name = self._snapshot_name(event.get("device_name"))
            if name and event.get("thumbnail_url") and name not in latest:
                latest[name] = event

        # HomeBase Pro can retain an earlier device label in AIC records after the
        # user renames a camera or separates a shared account. Resolve that alias
        # only when both sides are unambiguous; never let one doorbell's evidence
        # populate another doorbell's camera entity.
        doorbell_devices = [
            device
            for device in self.devices.values()
            if "doorbell" in self._snapshot_name(device.name)
        ]
        doorbell_events = [
            event for name, event in latest.items() if "doorbell" in name
        ]
        unique_doorbell_event = (
            doorbell_events[0]
            if len(doorbell_devices) == 1 and len(doorbell_events) == 1
            else None
        )

        updated = 0
        for device in self.devices.values():
            candidates = [
                event
                for name, event in latest.items()
                if name == self._snapshot_name(device.name)
                or name in self._snapshot_name(device.name)
                or self._snapshot_name(device.name) in name
            ]
            if (
                not candidates
                and unique_doorbell_event is not None
                and device is doorbell_devices[0]
            ):
                candidates = [unique_doorbell_event]
            if not candidates:
                continue
            event = candidates[0]
            try:
                async with asyncio.timeout(15):
                    content, content_type = await self.evidence_thumbnail(
                        event["event_id"]
                    )
            except (ValueError, RuntimeError, asyncio.TimeoutError):
                continue
            if not self._valid_snapshot(content):
                continue
            device.properties["picture"] = {
                "data": content,
                "type": {"mime": content_type},
            }
            try:
                device.image_last_updated = datetime.fromisoformat(
                    event["start"].replace("Z", "+00:00")
                )
            except (AttributeError, TypeError, ValueError):
                device.image_last_updated = datetime.now(timezone.utc)
            device.snapshot_source = event.get("source") or "hybrid_index"
            updated += 1

        if updated:
            self.async_set_updated_data(self.data)
            self._schedule_snapshot_cache_write()
        return {
            "updated": updated,
            # P2P/FFmpeg snapshot capture is deliberately excluded from this
            # background worker. On camera-heavy accounts it can starve Core and
            # Supervisor even when sessions are serialized. Live stays explicit.
            "scheduled_live_captures": 0,
            "indexed_events": len(result.get("events", [])),
            "warnings": result.get("warnings", []),
        }

    @staticmethod
    def _snapshot_name(value) -> str:
        return "".join(character for character in str(value or "").lower() if character.isalnum())

    @staticmethod
    def _device_channel(device) -> int | None:
        """Return the camera channel across current and legacy bridge spellings."""
        for key in ("deviceChannel", "device_channel", "channel"):
            value = device.properties.get(key)
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                continue
            if 0 <= parsed <= 255:
                return parsed
        return None

    @staticmethod
    def _valid_snapshot(content: bytes) -> bool:
        return is_valid_snapshot(content)

    @callback
    def async_update_listeners(self) -> None:
        """Update entities and persist any newly delivered event snapshots."""
        super().async_update_listeners()
        self._schedule_snapshot_cache_write()

    @callback
    def _schedule_snapshot_cache_write(self) -> None:
        """Coalesce bridge property bursts into one background cache writer."""
        self._snapshot_cache_dirty = True
        if self._snapshot_cache_task is None or self._snapshot_cache_task.done():
            self._snapshot_cache_task = self.hass.async_create_background_task(
                self._snapshot_cache_writer(),
                "baiamonte_eufy_snapshot_cache",
            )

    async def _snapshot_cache_writer(self) -> None:
        """Atomically persist valid camera snapshots without blocking Core."""
        try:
            while self._snapshot_cache_dirty:
                self._snapshot_cache_dirty = False
                records = []
                for device in self.devices.values():
                    if not getattr(device, "is_camera", False):
                        continue
                    try:
                        content = device.picture_bytes
                    except (KeyError, TypeError, ValueError):
                        continue
                    if not self._valid_snapshot(content):
                        continue
                    picture = device.properties.get("picture") or {}
                    image_type = picture.get("type") if isinstance(picture, dict) else {}
                    updated_at = device.image_last_updated
                    records.append(
                        (
                            self._snapshot_cache_key(device.serial_no),
                            content,
                            {
                                "updated_at": (
                                    updated_at.isoformat() if updated_at else None
                                ),
                                "source": device.snapshot_source or "push_cache",
                                "mime": (
                                    image_type.get("mime")
                                    if isinstance(image_type, dict)
                                    else None
                                )
                                or "image/jpeg",
                            },
                        )
                    )
                await asyncio.to_thread(
                    self._write_snapshot_records,
                    self._snapshot_cache_dir,
                    records,
                )
        except (OSError, ValueError) as exc:
            _LOGGER.warning("Snapshot disk cache write deferred: %s", type(exc).__name__)

    async def _restore_snapshot_cache(self) -> None:
        """Restore the last valid image for cameras missing one after restart."""
        restored = 0
        for device in self.devices.values():
            if not getattr(device, "is_camera", False):
                continue
            cached = await asyncio.to_thread(
                self._read_snapshot_record,
                self._snapshot_cache_dir,
                self._snapshot_cache_key(device.serial_no),
            )
            if cached is None:
                continue
            content, metadata = cached
            if not self._valid_snapshot(content):
                continue
            current = b""
            try:
                current = device.picture_bytes
            except (KeyError, TypeError, ValueError):
                pass
            if self._valid_snapshot(current):
                if hashlib.sha256(current).digest() != hashlib.sha256(content).digest():
                    continue
            else:
                device.properties["picture"] = {
                    "data": content,
                    "type": {"mime": metadata.get("mime") or "image/jpeg"},
                }
                restored += 1
            try:
                device.image_last_updated = datetime.fromisoformat(
                    metadata["updated_at"].replace("Z", "+00:00")
                )
            except (AttributeError, KeyError, TypeError, ValueError):
                device.image_last_updated = None
            device.snapshot_source = disk_cache_source(metadata.get("source"))
        if restored:
            _LOGGER.info("Restored %s durable Eufy camera snapshots", restored)

    @staticmethod
    def _snapshot_cache_key(serial_no: str) -> str:
        return hashlib.sha256(str(serial_no).encode("utf-8")).hexdigest()[:32]

    @staticmethod
    def _write_snapshot_records(cache_dir: str, records: list[tuple]) -> None:
        os.makedirs(cache_dir, mode=0o700, exist_ok=True)
        for key, content, metadata in records:
            image_path = os.path.join(cache_dir, f"{key}.img")
            metadata_path = os.path.join(cache_dir, f"{key}.json")
            image_temp = f"{image_path}.tmp"
            metadata_temp = f"{metadata_path}.tmp"
            with open(image_temp, "wb") as stream:
                stream.write(content)
            with open(metadata_temp, "w", encoding="utf-8") as stream:
                json.dump(metadata, stream, separators=(",", ":"))
            os.replace(image_temp, image_path)
            os.replace(metadata_temp, metadata_path)

    @staticmethod
    def _read_snapshot_record(cache_dir: str, key: str) -> tuple[bytes, dict] | None:
        try:
            with open(os.path.join(cache_dir, f"{key}.img"), "rb") as stream:
                content = stream.read(10 * 1024 * 1024 + 1)
            with open(
                os.path.join(cache_dir, f"{key}.json"),
                encoding="utf-8",
            ) as stream:
                metadata = json.load(stream)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
            return None
        return content, metadata if isinstance(metadata, dict) else {}

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

    @staticmethod
    def _record_field(record: dict, *names: str):
        """Return the first populated spelling from a HomeBase database row."""
        for name in names:
            value = record.get(name)
            if value not in (None, ""):
                return value
        return None

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
        elif source == "aic":
            history = record.get("history") if isinstance(record.get("history"), dict) else record
            pictures = record.get("picture") if isinstance(record.get("picture"), list) else []
            latest_update = (
                record.get("latest_update")
                if isinstance(record.get("latest_update"), dict)
                else {}
            )
            latest_event = (
                latest_update.get("event")
                if isinstance(latest_update.get("event"), dict)
                else {}
            )
            station_serial = record.get("station_sn") or self._record_field(
                history, "station_sn", "stationSn", "aic_sn", "aicSn"
            )
            # Prefer the Pro's signed cloud snapshot, then try its local thumbnail
            # and crop paths. Current firmware can put these fields on history,
            # latest_update, or latest_update.event.
            sources = (history, latest_update, latest_event, *pictures)
            files = []
            for names in (
                ("snapshot_cloud", "snapshotCloud"),
                ("thumb_path", "thumbPath", "thumbnail_path", "thumbnailPath"),
                ("crop_path", "cropPath"),
            ):
                for item in sources:
                    if not isinstance(item, dict):
                        continue
                    candidate = self._record_field(item, *names)
                    if candidate and candidate not in files:
                        files.append(candidate)
            last_error = None
            for candidate in files:
                if isinstance(candidate, str) and candidate.startswith("https://"):
                    try:
                        return await self._download_trusted_eufy_image(candidate)
                    except (ValueError, RuntimeError, aiohttp.ClientError) as exc:
                        last_error = exc
            station = self.stations.get(station_serial)
            if station is not None:
                for candidate in files:
                    if not isinstance(candidate, str) or candidate.startswith("https://"):
                        continue
                    try:
                        picture = await station.download_image(candidate)
                        data = self._buffer_bytes(picture.get("data"))
                        if not data:
                            continue
                        image_type = (
                            picture.get("type")
                            if isinstance(picture.get("type"), dict)
                            else {}
                        )
                        return data, image_type.get("mime") or "application/octet-stream"
                    except (ValueError, RuntimeError, WebSocketConnectionException) as exc:
                        last_error = exc
            if last_error is not None:
                raise ValueError("HomeBase thumbnail sources were unavailable") from last_error
            raise ValueError("This event has no retrievable HomeBase thumbnail")
        else:
            history = record.get("history") if isinstance(record.get("history"), dict) else record
            station_serial = record.get("station_sn") or history.get("station_sn")
            file = history.get("thumb_path")
        if isinstance(file, str) and file.startswith("https://"):
            return await self._download_trusted_eufy_image(file)
        station = self.stations.get(station_serial)
        if station is None or not file:
            raise ValueError("This event has no retrievable HomeBase thumbnail")
        picture = await station.download_image(file)
        data = self._buffer_bytes(picture.get("data"))
        if not data:
            raise ValueError("HomeBase returned an empty thumbnail")
        image_type = picture.get("type") if isinstance(picture.get("type"), dict) else {}
        return data, image_type.get("mime") or "application/octet-stream"

    async def _download_trusted_eufy_image(self, source_url: str) -> tuple[bytes, str]:
        """Fetch one bounded signed Eufy image without revealing its URL."""
        parsed = urlparse(source_url)
        hostname = (parsed.hostname or "").lower()
        trusted_suffixes = (
            ".eufylife.com",
            ".eufy.com",
            ".anker.com",
            ".ankercs.com",
            ".amazonaws.com",
            ".cloudfront.net",
        )
        if parsed.scheme != "https" or not any(
            hostname == suffix[1:] or hostname.endswith(suffix)
            for suffix in trusted_suffixes
        ):
            raise ValueError("Eufy did not provide a trusted image host")
        async with self._session.get(
            source_url,
            allow_redirects=False,
            timeout=aiohttp.ClientTimeout(total=20),
        ) as response:
            response.raise_for_status()
            if not response.content_type.startswith("image/"):
                raise ValueError("Eufy image endpoint did not return an image")
            if response.content_length and response.content_length > 10 * 1024 * 1024:
                raise ValueError("Eufy image exceeds 10 MB limit")
            data = await response.read()
            if not self._valid_snapshot(data):
                raise ValueError("Eufy image payload is invalid")
            return data, response.content_type or "application/octet-stream"

    async def evidence_ai_image(self, event_id: str, index: int) -> tuple[bytes, str]:
        """Retrieve a face/crop image without disclosing its cloud or disk location."""
        source, record = self._evidence(event_id)
        if source in {"local", "aic"}:
            pictures = record.get("picture") if isinstance(record.get("picture"), list) else []
            if index < 0 or index >= len(pictures):
                raise ValueError("AI crop does not exist")
            history = record.get("history") if isinstance(record.get("history"), dict) else record
            station_serial = record.get("station_sn") or self._record_field(
                history, "station_sn", "stationSn", "aic_sn", "aicSn"
            )
            file = self._record_field(
                pictures[index], "crop_path", "cropPath", "thumb_path", "thumbPath"
            )
            if isinstance(file, str) and file.startswith("https://"):
                return await self._download_trusted_eufy_image(file)
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
        if source in {"local", "aic"}:
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
            # The bridge websocket is event-driven. A full account ``poll_refresh``
            # fans thousands of device/property events into Home Assistant at once
            # on this estate and can block Core long enough for app websocket PONGs
            # to expire. Keep the scheduled coordinator update to a cheap bridge
            # health read; commands that need an explicit refresh still request it
            # at the product/API layer.
            await self._refresh_bridge_status()
            _LOGGER.debug("coordinator - complete update_local")
            return self.data
        except WebSocketConnectionException as exc:
            raise UpdateFailed(f"Error communicating with Add-on: {exc}") from exc

    async def disconnect(self):
        """disconnect from api"""
        if self._daily_snapshot_unsub is not None:
            self._daily_snapshot_unsub()
            self._daily_snapshot_unsub = None
        if self._daily_snapshot_task is not None:
            self._daily_snapshot_task.cancel()
            await asyncio.gather(self._daily_snapshot_task, return_exceptions=True)
            self._daily_snapshot_task = None
        if self._snapshot_cache_task is not None:
            await asyncio.gather(self._snapshot_cache_task, return_exceptions=True)
            self._snapshot_cache_task = None
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
