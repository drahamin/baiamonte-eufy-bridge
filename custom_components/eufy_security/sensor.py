import json
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
    CAPABILITY_PROPERTY_PATTERN,
    COORDINATOR,
    DOMAIN,
    Platform,
    PlatformToPropertyType,
    PropertyType,
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
    structured_ai_properties = []
    for product in [*coordinator.devices.values(), *coordinator.stations.values()]:
        structured_ai_properties.extend(
            metadata
            for metadata in product.metadata.values()
            if metadata.readable
            and metadata.type is PropertyType.object
            and CAPABILITY_PROPERTY_PATTERN.search(metadata.name) is not None
        )
    entities.extend(
        EufySecurityStructuredAISensor(coordinator, metadata)
        for metadata in structured_ai_properties
    )
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
        compatibility = mega.get("compatibility", {}) or {}
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
        complex_ai_fields = {
            prop.get("name")
            for model in models
            for prop in model.get("complexAiProperties", [])
            if prop.get("name")
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
            "official_catalog_requests": catalogs.get(
                "requests", catalogs.get("attempted", 0)
            ),
            "effective_native_catalogs": catalogs.get(
                "effectiveAvailable",
                catalogs.get("available", 0) + catalogs.get("synthesized", 0),
            ),
            "ai_metadata_fields": len(ai_fields),
            "ai_entity_compatible_fields": len(entity_ai_fields),
            "ai_structured_diagnostic_fields": len(complex_ai_fields),
            "writable_ai_controls": len(writable_ai),
            "companion_ai_coverage_percent": (
                round(len(entity_ai_fields) * 100 / len(ai_fields), 1)
                if ai_fields
                else None
            ),
            "compatibility_fallback_active": bool(mega.get("legacyFallbackRequired")),
            "compatibility_inventory_active": bool(compatibility.get("inventory")),
            "compatibility_properties_active": bool(compatibility.get("properties")),
            "compatibility_cloud_commands_active": bool(
                compatibility.get("cloudCommands")
            ),
            "updated_at": status.get("generatedAt"),
        }


class EufySecuritySensor(SensorEntity, EufySecurityEntity):
    """Base sensor entity for integration"""

    def __init__(
        self, coordinator: EufySecurityDataUpdateCoordinator, metadata: Metadata
    ) -> None:
        super().__init__(coordinator, metadata)
        if metadata.name == "pictureUrl":
            self._attr_name = f"{self.product.name} Event Image Status"
        # Home Assistant does not permit read-only SensorEntity instances in the
        # CONFIG category. Some newly discovered Eufy properties are both
        # readable and writable, so they already have a proper control entity
        # while this sensor is only a diagnostic view of the current value.
        if self._attr_entity_category == EntityCategory.CONFIG:
            self._attr_entity_category = EntityCategory.DIAGNOSTIC
            self._attr_entity_registry_enabled_default = False
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

        if self.metadata.name == "pictureUrl":
            return (
                "Available"
                if getattr(self.product, "picture_base64", None) is not None
                else "Waiting for event"
            )

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


def _structured_shape(value) -> dict:
    """Describe a complex value without exposing recognition data or configuration values."""
    if value is None:
        return {"kind": "unavailable", "item_count": 0, "keys": [], "field_types": {}}
    parsed = value
    if isinstance(value, str):
        if len(value) > 65536:
            return {
                "kind": "string",
                "item_count": 1,
                "keys": [],
                "field_types": {},
            }
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {
                "kind": "string",
                "item_count": 1 if value else 0,
                "keys": [],
                "field_types": {},
            }
    if isinstance(parsed, list):
        objects = [item for item in parsed[:16] if isinstance(item, dict)]
        keys = sorted(
            {
                key
                for item in objects
                for key in list(item)[:32]
                if isinstance(key, str)
            }
        )[:64]
        field_types = {
            key: sorted(
                {
                    "array"
                    if isinstance(item.get(key), list)
                    else "object"
                    if isinstance(item.get(key), dict)
                    else "null"
                    if item.get(key) is None
                    else type(item.get(key)).__name__
                    for item in objects
                    if key in item
                }
            )
            for key in keys
        }
        return {
            "kind": "array",
            "item_count": len(parsed),
            "keys": keys,
            "field_types": field_types,
        }
    if isinstance(parsed, dict):
        keys = sorted(key for key in parsed if isinstance(key, str))[:64]
        field_types = {
            key: "array"
            if isinstance(parsed[key], list)
            else "object"
            if isinstance(parsed[key], dict)
            else "null"
            if parsed[key] is None
            else type(parsed[key]).__name__
            for key in keys
        }
        return {
            "kind": "object",
            "item_count": len(parsed),
            "keys": keys,
            "field_types": field_types,
        }
    return {
        "kind": type(parsed).__name__,
        "item_count": 1,
        "keys": [],
        "field_types": {},
    }


class EufySecurityStructuredAISensor(SensorEntity, EufySecurityEntity):
    """Expose only the safe structure of a complex capability property."""

    def __init__(
        self, coordinator: EufySecurityDataUpdateCoordinator, metadata: Metadata
    ) -> None:
        super().__init__(coordinator, metadata)
        if metadata.name.startswith("storageInfo"):
            self._attr_icon = "mdi:harddisk"
        elif metadata.name.startswith("simSlot"):
            self._attr_icon = "mdi:sim"
        else:
            self._attr_icon = "mdi:brain"
        # A complex property may be writable at the bridge, but this entity intentionally is not.
        # Home Assistant also rejects config-category sensors without a writable entity surface.
        self._attr_entity_category = EntityCategory.DIAGNOSTIC
        self._attr_entity_registry_enabled_default = False

    @property
    def _shape(self) -> dict:
        return _structured_shape(self.product.properties.get(self.metadata.name))

    @property
    def native_value(self):
        return self._shape["kind"]

    @property
    def extra_state_attributes(self):
        shape = self._shape
        return {
            "field": self.metadata.name,
            "item_count": shape["item_count"],
            "keys": shape["keys"],
            "field_types": shape["field_types"],
            "raw_values_exposed": False,
            "write_control_exposed": False,
            "bridge_reports_writable": self.metadata.writeable,
        }
