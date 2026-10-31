"""Dependency-free checks for bounded P2P stream reuse."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_stream_linger_is_bounded_and_user_configurable() -> None:
    model = (ROOT / "custom_components/eufy_security/model.py").read_text()
    flow = (ROOT / "custom_components/eufy_security/config_flow.py").read_text()

    assert "stream_linger_seconds = 8" in model
    assert "ConfigField.stream_linger_seconds.name" in flow
    assert "vol.Range(min=0, max=30)" in flow


def test_stream_linger_reuses_only_an_explicitly_opened_source() -> None:
    camera = (ROOT / "custom_components/eufy_security/camera.py").read_text()
    stream_source = camera[
        camera.index("async def stream_source") :
        camera.index("async def handle_async_mjpeg_stream")
    ]
    cleanup = camera[
        camera.index("def _schedule_p2p_stream_stop") :
        camera.index("async def handle_async_mjpeg_stream")
    ]

    assert "if self.is_streaming is False" in stream_source
    assert "self._cancel_pending_stream_stop()" in stream_source
    assert "self.product.start_livestream" not in stream_source
    assert "max(0, min(30" in cleanup
    assert "self.product.stream_provider != StreamProvider.P2P" in cleanup
    assert "await self.product.stop_livestream()" in cleanup


def test_explicit_stop_and_unload_cancel_the_linger() -> None:
    camera = (ROOT / "custom_components/eufy_security/camera.py").read_text()
    explicit_stop = camera[
        camera.index("async def _stop_livestream") :
        camera.index("async def _start_rtsp_livestream")
    ]
    unload = camera[
        camera.index("async def async_will_remove_from_hass") :
        camera.index("async def _start_rtsp_livestream")
    ]

    assert "self._cancel_pending_stream_stop()" in explicit_stop
    assert "self._cancel_pending_stream_stop()" in unload
    assert "await self.product.stop_livestream()" in unload


def test_one_viewer_never_stops_a_source_another_viewer_is_using() -> None:
    camera = (ROOT / "custom_components/eufy_security/camera.py").read_text()
    proxy = camera[
        camera.index("async def handle_async_mjpeg_stream") :
        camera.index("async def async_create_stream")
    ]

    assert "self._active_proxy_viewers += 1" in proxy
    assert "self._active_proxy_viewers = max(0, self._active_proxy_viewers - 1)" in proxy
    assert "and self._active_proxy_viewers == 0" in proxy
