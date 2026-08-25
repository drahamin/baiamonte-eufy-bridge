"""Privacy-safe diagnostics for Baiamonte Eufy Security."""

from __future__ import annotations

from collections import Counter
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.redact import async_redact_data

from .const import COORDINATOR, DOMAIN

TO_REDACT = {
    "host",
    "rtsp_server_address",
    "captcha_id",
    "captcha_img",
    "captcha_input",
    "mfa_input",
    "serialNumber",
    "serial_number",
}


def _model_counts(products: dict[str, Any] | None) -> dict[str, int]:
    """Count product models without exposing names or serial numbers."""
    return dict(
        Counter((product.model or "Unknown") for product in (products or {}).values())
    )


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, config_entry: ConfigEntry
) -> dict[str, Any]:
    """Return redacted integration and bridge health information."""
    coordinator = hass.data[DOMAIN][COORDINATOR]
    status = coordinator.data.get("bridge") or {}
    mega = status.get("mega", {}) or {}
    observed = mega.get("observedSchemas", {}) or {}
    parameters = mega.get("inventory", {}).get("parameters", {}) or {}
    catalogs = mega.get("catalogs", {}) or {}
    compatibility = mega.get("compatibility", {}) or {}
    return {
        "integration": {
            "version": "9.2.0",
            "entry_version": config_entry.version,
            "data": async_redact_data(dict(config_entry.data), TO_REDACT),
            "options": async_redact_data(dict(config_entry.options), TO_REDACT),
            "websocket_available": coordinator.available,
            "dashboard_error_type": coordinator.last_bridge_error,
        },
        "inventory": {
            "devices": len(coordinator.devices or {}),
            "stations": len(coordinator.stations or {}),
            "device_models": _model_counts(coordinator.devices),
            "station_models": _model_counts(coordinator.stations),
        },
        "mega_catalog": {
            "authenticated": bool(mega.get("megaAuthenticated")),
            "models": observed.get("products", 0),
            "data_points": observed.get("dataPoints", 0),
            "verified": observed.get("known", 0),
            "classified": observed.get("classified", 0),
            "unresolved": observed.get("unknown", 0),
            "unique_ids": len(parameters.get("types", [])),
            "unique_verified": len(parameters.get("knownTypes", [])),
            "unique_classified": len(parameters.get("classifiedTypes", [])),
            "unique_unresolved": len(parameters.get("unknownTypes", [])),
            "official_descriptor_catalogs": catalogs.get("available", 0),
            "official_descriptor_requests": catalogs.get(
                "requests", catalogs.get("attempted", 0)
            ),
            "effective_native_read_catalogs": catalogs.get(
                "effectiveAvailable",
                catalogs.get("available", 0) + catalogs.get("synthesized", 0),
            ),
            "compatibility_fallback_active": bool(mega.get("legacyFallbackRequired")),
            "compatibility_inventory_active": bool(compatibility.get("inventory")),
            "compatibility_properties_active": bool(compatibility.get("properties")),
            "compatibility_cloud_commands_active": bool(
                compatibility.get("cloudCommands")
            ),
            "generated_at": status.get("generatedAt"),
        },
    }
