"""Baiamonte Eufy Security companion integration."""

from __future__ import annotations

import json
import logging
from typing import Any

import voluptuous as vol
from homeassistant.components.persistent_notification import async_create
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.device_registry import DeviceEntry
from homeassistant.helpers.typing import ConfigType

from .const import COORDINATOR, DOMAIN, NAME, PLATFORMS
from .coordinator import EufySecurityDataUpdateCoordinator
from .http import register_evidence_views
from .model import Config
from .panel import register_panel, register_panel_assets, unregister_panel

_LOGGER = logging.getLogger(__package__)
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


def _coordinator(hass: HomeAssistant) -> EufySecurityDataUpdateCoordinator:
    """Return the active bridge coordinator."""
    coordinator = hass.data.get(DOMAIN, {}).get(COORDINATOR)
    if coordinator is None:
        raise ServiceValidationError("Baiamonte Eufy Security is not loaded")
    return coordinator


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register bridge-level services."""
    hass.data.setdefault(DOMAIN, {})
    register_evidence_views(hass, _coordinator)
    await register_panel_assets(hass)
    entries = hass.config_entries.async_entries(DOMAIN)
    show_in_sidebar = Config.parse(entries[0]).show_sidebar_panel if entries else True
    await register_panel(hass, show_in_sidebar=show_in_sidebar)

    async def handle_send_message(call: ServiceCall) -> None:
        message: Any = call.data["message"]
        if isinstance(message, str):
            try:
                message = json.loads(message)
            except json.JSONDecodeError as exc:
                raise ServiceValidationError(
                    "message must contain a JSON object"
                ) from exc
        if not isinstance(message, dict):
            raise ServiceValidationError("message must be a JSON object")
        await _coordinator(hass).send_message(message)

    async def handle_force_sync(call: ServiceCall) -> None:
        await _coordinator(hass).async_request_refresh()

    async def handle_log_level(call: ServiceCall) -> None:
        await _coordinator(hass).set_log_level(call.data["log_level"])

    async def handle_search_events(call: ServiceCall) -> dict:
        return await _coordinator(hass).search_evidence(**call.data)

    async def handle_refresh_storage(call: ServiceCall) -> dict:
        return await _coordinator(hass).refresh_homebase_storage(
            call.data.get("station_serial", "")
        )

    async def handle_refresh_snapshots(call: ServiceCall) -> dict:
        """Refresh app-style cloud/Pro event snapshots without opening live video."""
        return await _coordinator(hass).refresh_latest_snapshots()

    hass.services.async_register(DOMAIN, "force_sync", handle_force_sync)
    hass.services.async_register(
        DOMAIN,
        "send_message",
        handle_send_message,
        schema=vol.Schema({vol.Required("message"): vol.Any(dict, str)}),
    )
    hass.services.async_register(
        DOMAIN,
        "search_events",
        handle_search_events,
        schema=vol.Schema(
            {
                vol.Optional("source", default="hybrid"): vol.In(
                    ["hybrid", "cloud", "local"]
                ),
                vol.Optional("days", default=1): vol.All(vol.Coerce(int), vol.Range(min=1, max=31)),
                vol.Optional("max_results", default=100): vol.All(vol.Coerce(int), vol.Range(min=1, max=200)),
                vol.Optional("station_serial", default=""): cv.string,
                vol.Optional("device_serial", default=""): cv.string,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "refresh_homebase_storage",
        handle_refresh_storage,
        schema=vol.Schema({vol.Optional("station_serial", default=""): cv.string}),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "refresh_snapshots",
        handle_refresh_snapshots,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "set_log_level",
        handle_log_level,
        schema=vol.Schema(
            {
                vol.Required("log_level"): vol.In(
                    ["silly", "trace", "debug", "info", "warn", "error", "fatal"]
                )
            }
        ),
    )
    return True


async def async_migrate_entry(hass: HomeAssistant, config_entry: ConfigEntry) -> bool:
    """Adopt an existing Eufy Security entry without changing entity identities."""
    if config_entry.version > 3:
        return False
    if config_entry.version < 3 or config_entry.title != NAME:
        options = dict(config_entry.options)
        if config_entry.version < 3:
            # The authenticated DVR panel uses Home Assistant's native HLS endpoint.
            # Older installations commonly carried this legacy CPU-saving switch.
            options["no_stream_in_hass"] = False
        hass.config_entries.async_update_entry(
            config_entry, title=NAME, version=3, options=options
        )
        _LOGGER.info("Migrated the existing Eufy Security entry to %s", NAME)
    return True


async def async_setup_entry(hass: HomeAssistant, config_entry: ConfigEntry) -> bool:
    """Connect to the Baiamonte bridge and create entities."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    coordinator = EufySecurityDataUpdateCoordinator(hass, config_entry)
    domain_data[COORDINATOR] = coordinator
    domain_data[config_entry.entry_id] = coordinator

    # The authenticated companion page is independent of bridge inventory. Keep
    # its route available while a large account initializes or reconnects.
    await register_panel(
        hass, show_in_sidebar=coordinator.config.show_sidebar_panel
    )
    await coordinator.initialize()
    await hass.config_entries.async_forward_entry_setups(config_entry, PLATFORMS)
    coordinator.platforms.extend(platform.value for platform in PLATFORMS)
    config_entry.async_on_unload(config_entry.add_update_listener(async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, config_entry: ConfigEntry) -> bool:
    """Unload entities and close the bridge connection."""
    domain_data = hass.data.get(DOMAIN, {})
    coordinator = domain_data.get(config_entry.entry_id) or domain_data.get(COORDINATOR)
    unloaded = await hass.config_entries.async_unload_platforms(config_entry, PLATFORMS)
    if unloaded and coordinator is not None:
        await coordinator.disconnect()
        domain_data.pop(config_entry.entry_id, None)
        if domain_data.get(COORDINATOR) is coordinator:
            domain_data.pop(COORDINATOR, None)
    if unloaded and config_entry.disabled_by is not None:
        unregister_panel(hass)
    return unloaded


async def async_reload_entry(hass: HomeAssistant, config_entry: ConfigEntry) -> None:
    """Reload an updated bridge configuration."""
    # Apply sidebar visibility immediately. The companion route is deliberately
    # independent of bridge connection and inventory setup.
    unregister_panel(hass)
    await register_panel(
        hass,
        show_in_sidebar=Config.parse(config_entry).show_sidebar_panel,
    )
    await hass.config_entries.async_reload(config_entry.entry_id)


async def async_remove_entry(
    hass: HomeAssistant, config_entry: ConfigEntry
) -> None:
    """Remove the companion panel when the integration entry is deleted."""
    unregister_panel(hass)


async def async_remove_config_entry_device(
    hass: HomeAssistant, config_entry: ConfigEntry, device_entry: DeviceEntry
) -> bool:
    """Prevent removal while a product remains present in bridge inventory."""
    identifiers = list(device_entry.identifiers)
    if not identifiers:
        return True
    serial_no = identifiers[0][1]
    coordinator = _coordinator(hass)
    if serial_no in coordinator.devices or serial_no in coordinator.stations:
        async_create(
            hass,
            "This device is still present in Baiamonte eufy Bridge inventory and cannot be removed.",
            title=NAME,
            notification_id="baiamonte_eufy_device_still_present",
        )
        return False
    return True
