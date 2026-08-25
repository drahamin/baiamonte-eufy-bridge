"""Coordinate Baiamonte Eufy Security bridge state."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

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
