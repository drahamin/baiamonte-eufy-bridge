from __future__ import annotations

import base64
import logging
from datetime import datetime

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import COORDINATOR, DOMAIN
from .coordinator import EufySecurityDataUpdateCoordinator
from .entity import EufySecurityEntity
from .eufy_security_api.metadata import Metadata

_LOGGER: logging.Logger = logging.getLogger(__package__)
_EMPTY_EVENT_IMAGE = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


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
        EufySecurityImage(coordinator, metadata) for metadata in product_properties
    ]
    async_add_entities(entities)


class EufySecurityImage(ImageEntity, EufySecurityEntity):
    """Base image entity for integration"""

    def __init__(
        self, coordinator: EufySecurityDataUpdateCoordinator, metadata: Metadata
    ) -> None:
        ImageEntity.__init__(self, coordinator.hass)
        EufySecurityEntity.__init__(self, coordinator, metadata)
        self._attr_name = f"{self.product.name} Event Image"

        # camera image
        self._last_image = None

    @property
    def image_last_updated(self) -> datetime | None:
        """The time when the image was last updated."""
        return self.product.image_last_updated

    async def async_image(self) -> bytes | None:
        """Return bytes of image."""
        if self.product.picture_base64 is not None:
            self._last_image = self.product.picture_bytes
        return self._last_image or _EMPTY_EVENT_IMAGE

    @property
    def extra_state_attributes(self):
        """Advertise cached evidence without exposing its source URL or device ID."""
        return {
            **EufySecurityEntity.extra_state_attributes.fget(self),
            "event_image_available": self.product.picture_base64 is not None,
        }
