import asyncio
import logging
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
        await self._on_open()

    async def disconnect(self):
        """Close web socket connection"""
        if self.task is not None:
            self.task.cancel()
            self.task = None
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
                await self.message_callback(message.json())
        except DeviceNotInitializedYetException:
            _LOGGER.debug(
                "Ignored device event received before inventory initialization"
            )
        except Exception as exc:
            _LOGGER.error("Unable to process WebSocket message: %s", type(exc).__name__)

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
