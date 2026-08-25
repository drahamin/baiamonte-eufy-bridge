"""Coordinate Baiamonte Eufy Security bridge state."""

from __future__ import annotations

import asyncio
import logging
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
from .evidence import event_merge_key, normalize_cloud_event, normalize_local_event

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

    async def initialize(self):
        """Initialize the integration"""
        try:
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
            events.extend(normalize_cloud_event(record) for record in raw)

        if source in {"hybrid", "local"}:
            for station in self.stations.values():
                if station_serial and station.serial_no != station_serial:
                    continue
                if "database_query_local" not in (station.commands or []):
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
                        start.isoformat(),
                        end.isoformat(),
                    )
                    events.extend(normalize_local_event(record) for record in raw)
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
            else:
                merged[key] = event
        result = sorted(
            merged.values(), key=lambda event: event.get("start") or "", reverse=True
        )[:max_results]
        return {
            "source": source,
            "window_days": days,
            "count": len(result),
            "local_homebase_models": sorted(set(local_stations)),
            "warnings": warnings,
            "events": result,
        }

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
