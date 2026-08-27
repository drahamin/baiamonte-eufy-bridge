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
