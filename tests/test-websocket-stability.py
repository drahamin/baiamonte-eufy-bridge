from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_bridge_websocket_tolerates_inventory_refresh_without_compression():
    source = (
        ROOT
        / "custom_components"
        / "eufy_security"
        / "eufy_security_api"
        / "web_socket_client.py"
    ).read_text(encoding="utf-8")

    assert "heartbeat=60" in source
    assert "compress=0" in source
    assert "heartbeat=10" not in source


def test_bridge_events_are_bounded_and_processed_off_the_result_path():
    source = (
        ROOT
        / "custom_components"
        / "eufy_security"
        / "eufy_security_api"
        / "web_socket_client.py"
    ).read_text(encoding="utf-8")

    assert "OrderedDict" in source
    assert "len(self._pending_events) >= 512" in source
    assert 'payload.get("type") == "event"' in source
    assert "await self._process_events" not in source


def test_bridge_error_frames_reconnect_without_unhandled_task_exception():
    source = (
        ROOT
        / "custom_components"
        / "eufy_security"
        / "eufy_security_api"
        / "web_socket_client.py"
    ).read_text(encoding="utf-8")

    assert 'elif msg.type == aiohttp.WSMsgType.ERROR:' in source
    assert 'raise WebSocketConnectionException("Bridge WebSocket transport error")' not in source
    assert '"Bridge WebSocket transport error; reconnecting: %s"' in source


def test_current_sdk_receive_buffer_and_native_light_are_backported():
    session_source = (
        ROOT
        / "eufy-mega-ws"
        / "vendor"
        / "eufy-security-client"
        / "src"
        / "p2p"
        / "session.ts"
    ).read_text(encoding="utf-8")
    constants = (
        ROOT / "custom_components" / "eufy_security" / "const.py"
    ).read_text(encoding="utf-8")
    light = (
        ROOT / "custom_components" / "eufy_security" / "light.py"
    ).read_text(encoding="utf-8")

    assert "UDP_RECVBUFFERSIZE_BYTES = 4 * 1024 * 1024" in session_source
    assert "Platform.LIGHT" in constants
    assert "class EufyLightEntity" in light


def test_pro_dashboard_uses_bounded_wait_and_awaits_before_headers():
    source = (
        ROOT / "eufy-mega-ws" / "dashboard" / "server.cjs"
    ).read_text(encoding="utf-8")

    assert "const bridgeSessionTimeoutMs = 50000" in source
    assert "const bridgeEventTimeoutMs = 40000" in source
    assert "}, bridgeSessionTimeoutMs);" in source
    assert "}, bridgeEventTimeoutMs);" in source
    assert "const result = await refreshAicSummary();" in source
    assert "const result = await refreshSolarWallSnapshots();" in source
    assert "JSON.stringify(await refreshAicSummary())" not in source


def test_bridge_owned_errors_and_malformed_messages_are_redacted():
    server = (
        ROOT
        / "eufy-mega-ws"
        / "vendor"
        / "eufy-security-ws"
        / "src"
        / "lib"
        / "server.ts"
    ).read_text(encoding="utf-8")
    logging = (
        ROOT
        / "eufy-mega-ws"
        / "vendor"
        / "eufy-security-ws"
        / "src"
        / "lib"
        / "logging.ts"
    ).read_text(encoding="utf-8")
    dashboard = (
        ROOT / "eufy-mega-ws" / "dashboard" / "server.cjs"
    ).read_text(encoding="utf-8")

    assert "redactErrorForLog(error)" in server
    assert "Unable to parse local WebSocket message" in server
    assert "Unable to parse data:" not in server
    assert "export const redactSensitiveText" in logging
    assert "function safeErrorMessage" in dashboard
    assert 'error: safeErrorMessage(error, "Bridge unavailable")' in dashboard
