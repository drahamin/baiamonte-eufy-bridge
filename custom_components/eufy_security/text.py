"""Writable text controls exposed by Baiamonte Eufy Security."""

from homeassistant.components.text import TextEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import COORDINATOR, DOMAIN, Platform, PlatformToPropertyType
from .coordinator import EufySecurityDataUpdateCoordinator
from .entity import EufySecurityEntity
from .eufy_security_api.metadata import Metadata
from .eufy_security_api.util import get_child_value
from .util import get_product_properties_by_filter


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up writable string properties."""
    coordinator: EufySecurityDataUpdateCoordinator = hass.data[DOMAIN][COORDINATOR]
    properties = get_product_properties_by_filter(
        [coordinator.devices.values(), coordinator.stations.values()],
        PlatformToPropertyType[Platform.TEXT.name].value,
    )
    async_add_entities(EufyTextEntity(coordinator, item) for item in properties)


class EufyTextEntity(TextEntity, EufySecurityEntity):
    """A writable bridge string property."""

    def __init__(
        self, coordinator: EufySecurityDataUpdateCoordinator, metadata: Metadata
    ) -> None:
        super().__init__(coordinator, metadata)

    @property
    def native_value(self) -> str | None:
        value = get_child_value(self.product.properties, self.metadata.name)
        return None if value is None else str(value)

    async def async_set_value(self, value: str) -> None:
        await self.product.set_property(self.metadata, value)
