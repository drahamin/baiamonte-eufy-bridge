"""Regression checks for quiet-camera event snapshot recovery."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_missing_snapshots_use_bounded_serial_scoped_history() -> None:
    source = (ROOT / "custom_components/eufy_security/coordinator.py").read_text()
    method = source.split("async def refresh_latest_snapshots", 1)[1].split(
        "@staticmethod\n    def _snapshot_name", 1
    )[0]

    assert 'source="hybrid"' in method
    assert "days=365" in method
    assert "max_results=20" in method
    assert "device_serial=device.serial_no" in method
    assert 'device.properties.get("stationSerialNumber")' in method
    assert "asyncio.Semaphore(2)" in method
    assert "6 * 60 * 60" in method
    assert "product_snapshot_bytes(device)" in method
    assert "device.picture_bytes" not in method
    assert "start_p2p_livestream" not in method
    assert '"thumbnail_failures": thumbnail_failures' in method


def test_routine_refresh_does_not_wait_for_missing_camera_recovery() -> None:
    coordinator = (ROOT / "custom_components/eufy_security/coordinator.py").read_text()
    integration = (ROOT / "custom_components/eufy_security/__init__.py").read_text()

    assert 'recover_missing: bool = False' in coordinator
    assert "if recover_missing" in coordinator
    assert "recover_missing=cycle > 0 and cycle % 12 == 0" in coordinator
    assert "self._snapshot_refresh_lock = asyncio.Lock()" in coordinator
    assert "if self._snapshot_refresh_lock.locked()" in coordinator
    assert '"deferred": True' in coordinator
    assert 'call.data.get("recover_missing", False)' in integration
    assert 'source="cloud"' in integration
    assert "thumbnail_semaphore = asyncio.Semaphore(4)" in coordinator
    assert "asyncio.timeout(8)" in coordinator


if __name__ == "__main__":
    test_missing_snapshots_use_bounded_serial_scoped_history()
    test_routine_refresh_does_not_wait_for_missing_camera_recovery()
