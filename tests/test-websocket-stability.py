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
