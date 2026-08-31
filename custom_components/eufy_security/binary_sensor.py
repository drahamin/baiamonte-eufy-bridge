import logging

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    BRIDGE_DEVICE_ID,
    COORDINATOR,
    DOMAIN,
    Platform,
    PlatformToPropertyType,
)
from .coordinator import EufySecurityDataUpdateCoordinator
from .entity import EufySecurityEntity
from .eufy_security_api.metadata import Metadata
from .eufy_security_api.product import Product
from .eufy_security_api.const import ProductType
from .eufy_security_api.util import get_child_value
from .util import get_device_info, get_product_properties_by_filter

_LOGGER: logging.Logger = logging.getLogger(__package__)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Setup binary sensor entities."""
    coordinator: EufySecurityDataUpdateCoordinator = hass.data[DOMAIN][COORDINATOR]
    product_properties = get_product_properties_by_filter(
        [coordinator.devices.values(), coordinator.stations.values()],
        PlatformToPropertyType[Platform.BINARY_SENSOR.name].value,
    )
    entities = [
        EufySecurityBinarySensor(coordinator, metadata)
        for metadata in product_properties
    ]

    for device in coordinator.devices.values():
        entities.append(EufySecurityProductEntity(coordinator, device))

    for device in coordinator.stations.values():
        entities.append(EufySecurityProductEntity(coordinator, device))
    entities.append(BaiamonteBridgeConnectionSensor(coordinator))
    async_add_entities(entities)


class BaiamonteBridgeConnectionSensor(CoordinatorEntity, BinarySensorEntity):
    """Report end-to-end availability of the companion bridge."""

    _attr_has_entity_name = True
    _attr_name = "Connection"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufySecurityDataUpdateCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{DOMAIN}_{BRIDGE_DEVICE_ID}_connected"

    @property
    def is_on(self) -> bool:
        status = self.coordinator.data.get("bridge") or {}
        return self.coordinator.available and status.get("bridge", {}).get(
            "available", False
        )

    @property
    def device_info(self):
        return {
            "identifiers": {(DOMAIN, BRIDGE_DEVICE_ID)},
            "name": "Baiamonte eufy Bridge",
            "manufacturer": "Baiamonte / eufy",
            "model": "Mega companion bridge",
        }


class EufySecurityBinarySensor(BinarySensorEntity, EufySecurityEntity):
    """Base binary sensor entity for integration"""

    def __init__(
        self, coordinator: EufySecurityDataUpdateCoordinator, metadata: Metadata
    ) -> None:
        super().__init__(coordinator, metadata)
        if metadata.name == "connected" and self.product.product_type == ProductType.station:
            self._attr_name = f"{self.product.name} Station P2P Session Connected"

    @property
    def is_on(self):
        """Return true if the binary sensor is on."""
        return bool(get_child_value(self.product.properties, self.metadata.name))


class EufySecurityProductEntity(BinarySensorEntity):
    """Privacy-safe capability summary for a bridge product."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_entity_registry_enabled_default = False

    def __init__(
        self, coordinator: EufySecurityDataUpdateCoordinator, product: Product
    ) -> None:
        super().__init__()
        self.coordinator = coordinator
        self.product = product
        self.product.set_state_update_listener(coordinator.async_update_listeners)

        self._attr_unique_id = (
            f"{DOMAIN}_{self.product.product_type.value}_{self.product.serial_no}_debug"
        )
        self._attr_should_poll = False
        self._attr_name = (
            f"{self.product.name} Debug ({self.product.product_type.value})"
        )

    async def async_added_to_hass(self) -> None:
        """Subscribe the diagnostic entity to its own product."""
        await super().async_added_to_hass()
        self.product.add_state_update_listener(self.async_write_ha_state)

    async def async_will_remove_from_hass(self) -> None:
        """Remove the product-scoped diagnostic listener."""
        self.product.remove_state_update_listener(self.async_write_ha_state)
        await super().async_will_remove_from_hass()

    @property
    def available(self) -> bool:
        return self.coordinator.available

    @property
    def is_on(self):
        """Return true if the binary sensor is on."""
        return True

    @property
    def extra_state_attributes(self):
        return {
            "property_names": sorted(self.product.metadata),
            "commands": sorted(self.product.commands),
            "quick_response_voice_count": (
                len(self.product.voices or {}) if self.product.is_camera else 0
            ),
        }

    @property
    def device_info(self):
        return get_device_info(self.product)
