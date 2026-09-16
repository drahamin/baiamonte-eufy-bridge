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


def test_pro_dashboard_waits_for_bounded_helper_completion():
    source = (
        ROOT / "eufy-mega-ws" / "dashboard" / "server.cjs"
    ).read_text(encoding="utf-8")

    assert "const bridgeSessionTimeoutMs = 65000" in source
    assert "const bridgeEventTimeoutMs = 62000" in source
    assert "}, bridgeSessionTimeoutMs);" in source
    assert "}, bridgeEventTimeoutMs);" in source
