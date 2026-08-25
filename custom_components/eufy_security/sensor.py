import logging
from enum import Enum

from homeassistant.components.sensor import SensorEntity, SensorStateClass
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
from .eufy_security_api.util import get_child_value
from .util import get_product_properties_by_filter

PERSON_NAME = "personName"
EMPTY = ""
UNKNOWN = "Unknown"
PERSON_NAME_STATE_EMPTY = "No Person"
PERSON_NAME_STATE_UNKNOWN = "Unknown Person"
PERSON_NAME_VALUE_TO_STATE = {
    EMPTY: PERSON_NAME_STATE_EMPTY,
    UNKNOWN: PERSON_NAME_STATE_UNKNOWN,
}

_LOGGER: logging.Logger = logging.getLogger(__package__)


class CameraSensor(Enum):
    """Camera specific class attributes to be presented as sensor"""

    stream_provider = "Stream Provider"
    stream_url = "Stream URL"
    stream_status = "Stream Status"
    video_queue_size = "Video Queue Size"
    audio_queue_size = "Audio Queue Size"


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Setup sensor entities."""
    coordinator: EufySecurityDataUpdateCoordinator = hass.data[DOMAIN][COORDINATOR]
    product_properties = get_product_properties_by_filter(
        [coordinator.devices.values(), coordinator.stations.values()],
        PlatformToPropertyType[Platform.SENSOR.name].value,
    )
    for camera in coordinator.devices.values():
        if camera.is_camera is True:
            for metadata in CameraSensor:
                product_properties.append(
                    Metadata.parse(
                        camera, {"name": metadata.name, "label": metadata.value}
                    )
                )
    entities = [
        EufySecuritySensor(coordinator, metadata) for metadata in product_properties
    ]
    entities.append(BaiamonteCatalogCoverageSensor(coordinator))
    async_add_entities(entities)


class BaiamonteCatalogCoverageSensor(CoordinatorEntity, SensorEntity):
    """Summarize the bridge's redacted Mega catalog coverage."""

    _attr_has_entity_name = True
    _attr_name = "Mega catalog research coverage"
    _attr_native_unit_of_measurement = "%"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:database-search"

    def __init__(self, coordinator: EufySecurityDataUpdateCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{DOMAIN}_{BRIDGE_DEVICE_ID}_catalog_coverage"

    @property
    def device_info(self):
        return {
            "identifiers": {(DOMAIN, BRIDGE_DEVICE_ID)},
            "name": "Baiamonte eufy Bridge",
            "manufacturer": "Baiamonte / eufy",
            "model": "Mega companion bridge",
        }

    @property
    def available(self) -> bool:
        status = self.coordinator.data.get("bridge") or {}
        return self.coordinator.available and status.get("bridge", {}).get(
            "available", False
        )

    @property
    def native_value(self):
        observed = self._observed
        total = observed.get("dataPoints", 0)
        if not total:
            return None
        covered = observed.get("known", 0) + observed.get("classified", 0)
        return round(covered * 100 / total, 1)

    @property
    def _observed(self) -> dict:
        status = self.coordinator.data.get("bridge") or {}
        return status.get("mega", {}).get("observedSchemas", {}) or {}

    @property
    def extra_state_attributes(self):
        status = self.coordinator.data.get("bridge") or {}
        mega = status.get("mega", {}) or {}
        observed = self._observed
        inventory = mega.get("inventory", {}).get("parameters", {}) or {}
        catalogs = mega.get("catalogs", {}) or {}
        models = status.get("models", []) or []
        ai_fields = {
            name for model in models for name in model.get("aiPropertyNames", [])
        }
        writable_ai = {
            name for model in models for name in model.get("writableAiProperties", [])
        }
        entity_ai_fields = {
            name for model in models for name in model.get("entityAiPropertyNames", [])
        }
        data_points = observed.get("dataPoints", 0)
        semantic = (
            round(observed.get("known", 0) * 100 / data_points, 1)
            if data_points
            else None
        )
        return {
            "mega_authenticated": bool(mega.get("megaAuthenticated")),
            "schema_version": status.get("bridge", {}).get("schema"),
            "models": observed.get("products", 0),
            "data_points": data_points,
            "verified": observed.get("known", 0),
            "family_classified": observed.get("classified", 0),
            "unresolved": observed.get("unknown", 0),
            "semantic_coverage_percent": semantic,
            "unique_ids": len(inventory.get("types", [])),
            "unique_verified": len(inventory.get("knownTypes", [])),
            "unique_classified": len(inventory.get("classifiedTypes", [])),
            "unique_unresolved": len(inventory.get("unknownTypes", [])),
            "official_catalogs_populated": catalogs.get("available", 0),
            "official_catalogs_queried": catalogs.get("attempted", 0),
            "ai_metadata_fields": len(ai_fields),
            "ai_entity_compatible_fields": len(entity_ai_fields),
            "writable_ai_controls": len(writable_ai),
            "companion_ai_coverage_percent": (
                round(len(entity_ai_fields) * 100 / len(ai_fields), 1)
                if ai_fields
                else None
            ),
            "compatibility_fallback_active": bool(mega.get("legacyFallbackRequired")),
            "updated_at": status.get("generatedAt"),
        }


class EufySecuritySensor(SensorEntity, EufySecurityEntity):
    """Base sensor entity for integration"""

    def __init__(
        self, coordinator: EufySecurityDataUpdateCoordinator, metadata: Metadata
    ) -> None:
        super().__init__(coordinator, metadata)
        self._attr_state_class = self.description.state_class
        self._attr_native_unit_of_measurement = (
            self.description.unit if self.description.unit else metadata.unit
        )

    @property
    def native_value(self):
        """Return the value reported by the sensor."""
        if self.metadata.name in CameraSensor.__members__:
            if self.metadata.name == CameraSensor.video_queue_size.name:
                return len(self.product.video_queue)
            if self.metadata.name == CameraSensor.audio_queue_size.name:
                return len(self.product.audio_queue)
            if self.metadata.name == CameraSensor.stream_provider.name:
                return self.product.stream_provider.name
            return get_child_value(self.product.__dict__, self.metadata.name)

        value = get_child_value(self.product.properties, self.metadata.name)

        if self.metadata.name == PERSON_NAME:
            return PERSON_NAME_VALUE_TO_STATE.get(value, value)

        if self.metadata.states is not None:
            try:
                return self.metadata.states[str(value)]
            except KeyError:
                # _LOGGER.info(f"Exception handled - {ValueNotSetException(self.metadata)}")
                pass
        if len(str(value)) > 250:
            value = str(value)[-250:]
        return value
