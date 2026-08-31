import asyncio
import logging
from collections import OrderedDict
from collections.abc import Callable, Coroutine
from typing import Any, Text

import aiohttp

from .exceptions import (
    DeviceNotInitializedYetException,
    WebSocketConnectionException,
)

_LOGGER: logging.Logger = logging.getLogger(__package__)


class WebSocketClient:
    """Websocket Client to communicate with eufy-security-ws"""

    def __init__(
        self,
        host: str,
        port: int,
        session: aiohttp.ClientSession,
        open_callback: Callable[[], Coroutine[Any, Any, None]],
        message_callback: Callable[[], Coroutine[Any, Any, None]],
        close_callback: Callable[[], Coroutine[Any, Any, None]],
        error_callback: Callable[[Text], Coroutine[Any, Any, None]],
    ) -> None:
        self.host = host
        self.port = port
        self.session = session
        self.open_callback = open_callback
        self.message_callback = message_callback
        self.close_callback = close_callback
        self.error_callback = error_callback

        self.socket: aiohttp.ClientWebSocketResponse | None = None
        self.task: asyncio.Task | None = None
        self.event_task: asyncio.Task | None = None
        self._pending_events: OrderedDict[tuple, dict] = OrderedDict()
        self._event_ready = asyncio.Event()

    async def connect(self):
        """Set up web socket connection"""
        try:
            # The bridge can briefly pause its local event loop while it refreshes
            # the large Eufy account inventory. Keep this long-lived Home Assistant
            # connection lightweight and tolerant of a bounded bridge pause;
            # request/response calls retain their own explicit 30-second timeout.
            self.socket = await self.session.ws_connect(
                f"ws://{self.host}:{self.port}", heartbeat=60, compress=0
            )
        except Exception as exc:
            raise WebSocketConnectionException(
                "Connection to add-on was broken. please reload the integration!"
            ) from exc
        self.task = asyncio.create_task(self._process_messages())
        self.task.add_done_callback(self._on_close)
        self.event_task = asyncio.create_task(self._process_events())
        await self._on_open()

    async def disconnect(self):
        """Close web socket connection"""
        if self.task is not None:
            self.task.cancel()
            self.task = None
        if self.event_task is not None:
            self.event_task.cancel()
            await asyncio.gather(self.event_task, return_exceptions=True)
            self.event_task = None
        self._pending_events.clear()
        self._event_ready.clear()
        if self.socket is not None:
            await self.socket.close()
            self.socket = None

    async def _on_open(self) -> None:
        if self.open_callback is not None:
            await self.open_callback()

    async def _process_messages(self):
        async for msg in self.socket:
            if msg.type == aiohttp.WSMsgType.TEXT:
                await self._on_message(msg)
            elif msg.type in {
                aiohttp.WSMsgType.CLOSE,
                aiohttp.WSMsgType.CLOSED,
                aiohttp.WSMsgType.CLOSING,
            }:
                return
            elif msg.type == aiohttp.WSMsgType.ERROR:
                raise WebSocketConnectionException("Bridge WebSocket transport error")
            else:
                _LOGGER.debug("Ignored unsupported bridge WebSocket frame type")

    async def _on_message(self, message):
        try:
            if self.message_callback is not None:
                payload = message.json()
                # Results unblock bridge commands and inventory reads, so process
                # them immediately. Device/station events can arrive in bursts of
                # thousands on a large account; coalesce those on a separate,
                # bounded worker so they can never starve Home Assistant's HTTP
                # server or delay a command response behind stale state changes.
                if payload.get("type") == "event":
                    self._queue_event(payload)
                else:
                    await self.message_callback(payload)
        except DeviceNotInitializedYetException:
            _LOGGER.debug(
                "Ignored device event received before inventory initialization"
            )
        except Exception as exc:
            _LOGGER.error("Unable to process WebSocket message: %s", type(exc).__name__)

    def _queue_event(self, payload: dict) -> None:
        """Coalesce repetitive bridge events without losing the newest state."""
        event = payload.get("event") or {}
        key = (
            event.get("source"),
            event.get("serialNumber"),
            event.get("event"),
            event.get("name"),
        )
        if key in self._pending_events:
            self._pending_events.pop(key)
        elif len(self._pending_events) >= 512:
            self._pending_events.popitem(last=False)
            _LOGGER.warning("Dropped oldest Eufy event from the bounded Core queue")
        self._pending_events[key] = payload
        self._event_ready.set()

    async def _process_events(self) -> None:
        """Drain coalesced events cooperatively and keep Core responsive."""
        try:
            while True:
                await self._event_ready.wait()
                while self._pending_events:
                    _, payload = self._pending_events.popitem(last=False)
                    if self.message_callback is not None:
                        await self.message_callback(payload)
                    # Explicitly hand control back to Home Assistant between every
                    # state update; large Eufy accounts must not monopolize a loop
                    # iteration even when the bridge reconnects many stations.
                    await asyncio.sleep(0)
                self._event_ready.clear()
        except asyncio.CancelledError:
            return

    async def _on_error(self, error: Text = "Unspecified") -> None:
        if self.error_callback is not None:
            await self.error_callback(error)

    def _on_close(self, future="") -> None:
        self.socket = None
        _LOGGER.debug("Bridge WebSocket receive loop ended")
        if self.close_callback is not None:
            self.close_callback(future)

    async def send_message(self, message):
        """Send message to websocket"""
        if self.socket is None or self.socket.closed:
            raise WebSocketConnectionException(
                "Connection to Baiamonte eufy Bridge is closed"
            )
        await self.socket.send_str(message)

    @property
    def available(self) -> bool:
        return self.socket is not None and not self.socket.closed
