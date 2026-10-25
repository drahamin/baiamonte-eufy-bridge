"""Dependency-free tests for canonical snapshot retention."""

from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE = (
    Path(__file__).parents[1]
    / "custom_components/eufy_security/snapshot.py"
)
SPEC = importlib.util.spec_from_file_location("baiamonte_snapshot", MODULE)
assert SPEC and SPEC.loader
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)


class Product:
    """Minimal camera product used by the helper tests."""

    def __init__(self, content):
        self.picture_bytes = content


def test_valid_product_snapshot_replaces_fallback() -> None:
    current = b"\xff\xd8\xff" + (b"a" * 1200)
    fallback = b"\xff\xd8\xff" + (b"b" * 1200)
    assert snapshot.product_snapshot_bytes(Product(current), fallback) == current


def test_empty_product_snapshot_preserves_fallback() -> None:
    fallback = b"\xff\xd8\xff" + (b"b" * 1200)
    assert snapshot.product_snapshot_bytes(Product(b""), fallback) == fallback


def test_malformed_product_snapshot_is_not_advertised() -> None:
    assert snapshot.product_snapshot_bytes(Product(b"not-an-image")) is None


def test_disk_cache_source_is_idempotent_across_restarts() -> None:
    assert snapshot.disk_cache_source("push_event") == "disk_cache:push_event"
    assert snapshot.disk_cache_source("disk_cache:push_event") == "disk_cache:push_event"
    assert snapshot.disk_cache_source("disk_cache:disk_cache:push_event") == "disk_cache:push_event"


def test_push_receipt_time_does_not_outrank_dated_evidence() -> None:
    assert snapshot.snapshot_source_has_capture_time(None) is False
    assert snapshot.snapshot_source_has_capture_time("push_cache") is False
    assert snapshot.snapshot_source_has_capture_time("push_event") is False
    assert snapshot.snapshot_source_has_capture_time("disk_cache:push_event") is False


def test_dated_evidence_source_can_be_compared_by_time() -> None:
    assert snapshot.snapshot_source_has_capture_time("account_index") is True
    assert snapshot.snapshot_source_has_capture_time("homebase_pro_aic") is True
    assert snapshot.snapshot_source_has_capture_time("hybrid_index") is True
    assert snapshot.snapshot_source_has_capture_time("disk_cache:hybrid_index") is True


def test_snapshot_dimensions_reads_verified_image_geometry() -> None:
    from io import BytesIO
    from PIL import Image

    output = BytesIO()
    Image.new("RGB", (1920, 1080), "navy").save(output, format="JPEG")

    assert snapshot.snapshot_dimensions(output.getvalue()) == (1920, 1080)
    assert snapshot.snapshot_dimensions(b"not-an-image") == (0, 0)


def test_recognition_image_uses_stored_recording_without_live_video() -> None:
    root = Path(__file__).resolve().parents[1]
    coordinator = (root / "custom_components/eufy_security/coordinator.py").read_text()
    http = (root / "custom_components/eufy_security/http.py").read_text()
    method = coordinator[
        coordinator.index("async def evidence_recognition_image"):
        coordinator.index("async def _remux_recording")
    ]

    assert "video = await self.evidence_video(event_id)" in method
    assert "await self._recording_still(video)" in method
    assert "start_livestream" not in method
    assert 'url = "/api/baiamonte_eufy/evidence/{event_id}/recognition-image"' in http


def test_evidence_identity_prefers_serial_and_finds_nested_pro_channel() -> None:
    assert snapshot.evidence_identity(
        {
            "record": {
                "device_sn": "camera-current",
                "history": {"device_sn": "camera-old", "stationSn": "homebase-pro"},
                "latest_update": {"event": {"deviceChannel": "7"}},
            }
        }
    ) == ("camera-current", "homebase-pro", 7)


def test_evidence_identity_supports_current_app_spellings() -> None:
    assert snapshot.evidence_identity(
        {"deviceSerial": "camera-new", "aicSn": "pro-new", "mChannel": 3}
    ) == ("camera-new", "pro-new", 3)
