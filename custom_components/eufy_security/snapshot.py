"""Dependency-free helpers for retaining verified Eufy snapshot bytes."""

from __future__ import annotations

MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024


def disk_cache_source(source: object) -> str:
    """Mark restored evidence once, even across repeated Core restarts."""
    value = str(source or "event")
    while value.startswith("disk_cache:"):
        value = value.removeprefix("disk_cache:")
    return f"disk_cache:{value or 'event'}"


def is_valid_snapshot(content: object) -> bool:
    """Return whether content is a bounded JPEG, PNG, or WebP image."""
    if not isinstance(content, (bytes, bytearray, memoryview)):
        return False
    value = bytes(content)
    return 1000 < len(value) <= MAX_SNAPSHOT_BYTES and (
        value.startswith(b"\xff\xd8\xff")
        or value.startswith(b"\x89PNG\r\n\x1a\n")
        or (value.startswith(b"RIFF") and value[8:12] == b"WEBP")
    )


def product_snapshot_bytes(product, fallback: bytes | None = None) -> bytes | None:
    """Return a product's verified frame without discarding a valid fallback."""
    try:
        content = product.picture_bytes
    except (KeyError, TypeError, ValueError):
        content = None
    if is_valid_snapshot(content):
        return bytes(content)
    return bytes(fallback) if is_valid_snapshot(fallback) else None
