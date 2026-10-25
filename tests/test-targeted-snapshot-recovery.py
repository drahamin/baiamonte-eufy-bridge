"""Regression checks for quiet-camera event snapshot recovery."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_missing_snapshots_use_bounded_serial_scoped_history() -> None:
    source = (ROOT / "custom_components/eufy_security/coordinator.py").read_text()
    method = source.split("async def refresh_latest_snapshots", 1)[1].split(
        "@staticmethod\n    def _snapshot_name", 1
    )[0]

    assert 'source="cloud"' in method
    assert "days=31" in method
    assert "device_serial=device.serial_no" in method
    assert "asyncio.Semaphore(2)" in method
    assert "6 * 60 * 60" in method
    assert "start_p2p_livestream" not in method


if __name__ == "__main__":
    test_missing_snapshots_use_bounded_serial_scoped_history()
