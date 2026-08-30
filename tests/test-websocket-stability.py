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
