"""Baiamonte Eufy Security evidence panel registration."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

PANEL_PATH = "baiamonte-eufy-security"


async def register_panel(hass: HomeAssistant) -> None:
    """Register the authenticated live/evidence application."""
    www = Path(__file__).parent / "www"
    await hass.http.async_register_static_paths(
        [StaticPathConfig("/baiamonte_eufy_assets", str(www), False)]
    )
    if frontend.async_panel_exists(hass, PANEL_PATH):
        return
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_PATH,
        webcomponent_name="baiamonte-eufy-security-panel",
        module_url="/baiamonte_eufy_assets/evidence-panel.js?v=9.5.6",
        sidebar_title="Baiamonte Eufy Security",
        sidebar_icon="mdi:cctv",
        require_admin=False,
        handle_safe_area=True,
    )


def unregister_panel(hass: HomeAssistant) -> None:
    """Remove the panel when the integration is removed."""
    if frontend.async_panel_exists(hass, PANEL_PATH):
        frontend.async_remove_panel(hass, PANEL_PATH)
