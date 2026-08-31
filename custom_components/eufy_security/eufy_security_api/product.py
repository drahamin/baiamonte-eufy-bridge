import asyncio
import logging
from collections.abc import Callable
from typing import Any

from .const import EventNameToHandler, MessageField, ProductCommand, ProductType
from .event import Event
from .metadata import Metadata

_LOGGER: logging.Logger = logging.getLogger(__package__)


class Product:
    """Product"""

    def __init__(
        self,
        api,
        product_type: ProductType,
        serial_no: str,
        properties: dict,
        metadata: dict,
        commands: [],
    ) -> None:
        self.api = api
        self.product_type = product_type
        self.serial_no = serial_no

        self.name: str = None
        self.model: str = None
        self.hardware_version: str = None
        self.software_version: str = None

        self.properties: dict = None
        self.metadata: dict = None
        self.metadata_org = metadata
        self.commands = commands
        self.connected = True

        self.state_update_listeners: set[Callable] = set()

        self._set_properties(properties)
        self._set_metadata(metadata)

        self.pin_verified_future = None

    def _set_properties(self, properties: dict) -> None:
        self.properties = properties
        _LOGGER.debug("Initialized product properties")
        self.name = properties.get(MessageField.NAME.value, "UNSUPPORTED")
        self.model = properties.get(MessageField.MODEL.value, "UNSUPPORTED")
        self.hardware_version = properties.get(
            MessageField.HARDWARE_VERSION.value, "UNSUPPORTED"
        )
        self.software_version = properties.get(
            MessageField.SOFTWARE_VERSION.value, "UNSUPPORTED"
        )

    def _set_metadata(self, metadata: dict) -> None:
        self.metadata = {}

        for key, value in metadata.items():
            metadata = Metadata.parse(self, value)

            if key == "motionDetected" and metadata.name == "motionDetection":
                metadata.name = key

            self.metadata[key] = metadata

    def set_state_update_listener(self, listener: Callable):
        """Register a listener function when state changes."""
        self.add_state_update_listener(listener)

    def add_state_update_listener(self, listener: Callable) -> None:
        """Register one product-scoped state listener."""
        self.state_update_listeners.add(listener)

    def remove_state_update_listener(self, listener: Callable) -> None:
        """Remove one product-scoped state listener."""
        self.state_update_listeners.discard(listener)

    def notify_state_update(self) -> None:
        """Publish the newest product state to registered listeners."""
        for callback_func in tuple(self.state_update_listeners):
            callback_func()

    async def set_property(self, metadata, value: Any):
        """Process set property call"""
        await self.api.set_property(
            self.product_type, self.serial_no, metadata.name, value
        )

    async def trigger_alarm(self, duration: int = 10):
        """Process trigger alarm call"""
        await self.api.trigger_alarm(self.product_type, self.serial_no, duration)

    async def reset_alarm(self):
        """Process reset alarm call"""
        await self.api.reset_alarm(self.product_type, self.serial_no)

    async def snooze(
        self,
        snooze_time: int,
        snooze_chime: bool,
        snooze_motion: bool,
        snooze_homebase: bool,
    ) -> None:
        """Process snooze call"""
        await self.api.snooze(
            self.product_type,
            self.serial_no,
            snooze_time,
            snooze_chime,
            snooze_motion,
            snooze_homebase,
        )
        await self.api.poll_refresh()

    async def unlock(self, code: str) -> bool:
        """Process unlock the safe"""
        self.pin_verified_future = asyncio.get_running_loop().create_future()
        await self.api.verify_pin(self.product_type, self.serial_no, code)
        await asyncio.wait_for(self.pin_verified_future, timeout=5)
        event = self.pin_verified_future.result()
        if event.data[MessageField.SUCCESSFULL.value] is False:
            return False
        await self.api.unlock(self.product_type, self.serial_no)
        return True

    async def process_event(self, event: Event):
        """Act on received event"""
        handler_func = None

        try:
            handler = EventNameToHandler(event.type)
            handler_func = getattr(self, f"_handle_{handler.name}", None)
        except ValueError:
            # event is not acted on, skip it
            _LOGGER.debug("Ignored unsupported product event type %s", event.type)
            return

        if handler_func is not None:
            await handler_func(event)

        self.notify_state_update()

    async def _handle_property_changed(self, event: Event):
        self.properties[event.data[MessageField.NAME.value]] = event.data[
            MessageField.VALUE.value
        ]

    async def _handle_pin_verified(self, event: Event):
        self.pin_verified_future.set_result(event)

    async def _handle_connected(self, event: Event):
        self.properties[MessageField.CONNECTED.value] = True

    async def _handle_disconnected(self, event: Event):
        self.properties[MessageField.CONNECTED.value] = False

    async def _handle_connection_error(self, event: Event):
        self.properties[MessageField.CONNECTED.value] = False

    @property
    def is_camera(self):
        """checks if Product is camera"""
        return (
            True
            if ProductCommand.start_livestream.value.command in self.commands
            else False
        )

    @property
    def is_safe_lock(self):
        """checks if Product is safe lock"""
        return (
            True if ProductCommand.verify_pin.value.command in self.commands else False
        )

    def has(self, property_name: str) -> bool:
        """Checks if product has required property"""
        return False if self.properties.get(property_name, None) is None else True


class Device(Product):
    """Device as Physical Product"""

    def __init__(
        self, api, serial_no: str, properties: dict, metadata: dict, commands: []
    ) -> None:
        super().__init__(
            api, ProductType.device, serial_no, properties, metadata, commands
        )


class Station(Product):
    """Station as Physical Product"""

    def __init__(
        self, api, serial_no: str, properties: dict, metadata: dict, commands: []
    ) -> None:
        super().__init__(
            api, ProductType.station, serial_no, properties, metadata, commands
        )
        self._database_query_local_future = None
        self._database_query_aic_events_future = None
        self._database_query_by_date_future = None
        self._image_download_future = None
        self._image_download_file = None

    async def chime(self, ringtone: int) -> None:
        """Quick response message to camera"""
        await self.api.chime(self.product_type, self.serial_no, ringtone)

    async def reboot(self) -> None:
        """Reboot station"""
        await self.api.reboot(self.product_type, self.serial_no)

    async def database_query_local(
        self,
        serial_numbers: list[str],
        start_date: str,
        end_date: str,
        event_type: int = 0,
        detection_type: int = 0,
        storage_type: int = 0,
    ) -> list[dict]:
        """Return detailed local recording metadata from this HomeBase."""
        if not ({"database_query_local", "stationDatabaseQueryLocal"} & set(self.commands)):
            raise ValueError("This HomeBase does not advertise local record queries")
        if self._database_query_local_future is not None:
            raise RuntimeError("A local HomeBase record query is already running")
        self._database_query_local_future = asyncio.get_running_loop().create_future()
        try:
            await self.api.database_query_local(
                self.serial_no,
                serial_numbers,
                start_date,
                end_date,
                event_type,
                detection_type,
                storage_type,
            )
            return await asyncio.wait_for(self._database_query_local_future, timeout=45)
        finally:
            self._database_query_local_future = None

    async def database_query_aic_events(
        self, start_date: str, end_date: str, count: int = 100
    ) -> dict:
        """Return the HomeBase Pro AICEventData view used by the mobile app."""
        if not (
            {"database_query_aic_events", "stationDatabaseQueryAicEvents"}
            & set(self.commands)
        ):
            raise ValueError("This HomeBase does not advertise AIC evidence queries")
        if self._database_query_aic_events_future is not None:
            raise RuntimeError("A HomeBase AIC evidence query is already running")
        self._database_query_aic_events_future = (
            asyncio.get_running_loop().create_future()
        )
        try:
            await self.api.database_query_aic_events(
                self.serial_no, start_date, end_date, count
            )
            return await asyncio.wait_for(
                self._database_query_aic_events_future, timeout=45
            )
        finally:
            self._database_query_aic_events_future = None

    async def database_query_by_date(
        self,
        serial_numbers: list[str],
        start_date: str,
        end_date: str,
        event_type: int = 0,
        detection_type: int = 0,
        storage_type: int = 0,
    ) -> list[dict]:
        """Return the compact local recording date index from this HomeBase."""
        if not ({"database_query_by_date", "stationDatabaseQueryByDate"} & set(self.commands)):
            raise ValueError("This HomeBase does not advertise date-index queries")
        if self._database_query_by_date_future is not None:
            raise RuntimeError("A HomeBase date-index query is already running")
        self._database_query_by_date_future = asyncio.get_running_loop().create_future()
        try:
            await self.api.database_query_by_date(
                self.serial_no,
                serial_numbers,
                start_date,
                end_date,
                event_type,
                detection_type,
                storage_type,
            )
            return await asyncio.wait_for(self._database_query_by_date_future, timeout=45)
        finally:
            self._database_query_by_date_future = None

    async def _handle_database_query_local(self, event: Event):
        if (
            self._database_query_local_future is not None
            and not self._database_query_local_future.done()
        ):
            self._database_query_local_future.set_result(event.data.get("data", []))

    async def _handle_database_query_aic_events(self, event: Event):
        if (
            self._database_query_aic_events_future is not None
            and not self._database_query_aic_events_future.done()
        ):
            self._database_query_aic_events_future.set_result(
                event.data.get("data", {})
            )

    async def _handle_database_query_by_date(self, event: Event):
        if (
            self._database_query_by_date_future is not None
            and not self._database_query_by_date_future.done()
        ):
            self._database_query_by_date_future.set_result(event.data.get("data", []))

    async def download_image(self, file: str) -> dict:
        """Download one local evidence image from the HomeBase."""
        if not ({"download_image", "stationDownloadImage"} & set(self.commands)):
            raise ValueError("This HomeBase does not advertise image downloads")
        if self._image_download_future is not None:
            raise RuntimeError("A HomeBase image download is already running")
        self._image_download_file = file
        self._image_download_future = asyncio.get_running_loop().create_future()
        try:
            await self.api.download_image(self.serial_no, file)
            return await asyncio.wait_for(self._image_download_future, timeout=45)
        finally:
            self._image_download_future = None
            self._image_download_file = None

    async def _handle_image_downloaded(self, event: Event):
        if (
            self._image_download_future is not None
            and not self._image_download_future.done()
            and event.data.get("file") == self._image_download_file
        ):
            self._image_download_future.set_result(event.data.get("image", {}))
