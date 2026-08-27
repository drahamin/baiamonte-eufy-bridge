"""Helpers for retaining and presenting verified Eufy snapshot bytes."""

from __future__ import annotations

from functools import lru_cache
from io import BytesIO

try:
    from PIL import Image, ImageEnhance, ImageOps, ImageStat
except ImportError:  # Home Assistant includes Pillow; keep import tests portable.
    Image = ImageEnhance = ImageOps = ImageStat = None

MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024
MAX_ENHANCE_BYTES = 3 * 1024 * 1024


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


@lru_cache(maxsize=12)
def enhance_dashboard_snapshot(content: bytes) -> bytes:
    """Improve Eufy cover thumbnails without touching live video.

    Some current camera models expose only a compressed event cover to the
    compatibility bridge. Their JPEG is visibly washed out, overexposed, or
    soft compared with the Eufy application. Apply bounded tonal recovery to
    low-dynamic-range frames and mild sharpening to every small cover. The
    byte-keyed cache means the work runs once per changed image, not once per
    dashboard request.
    """
    if (
        Image is None
        or not content.startswith(b"\xff\xd8\xff")
        or len(content) > MAX_ENHANCE_BYTES
    ):
        return content
    try:
        with Image.open(BytesIO(content)) as source:
            source.load()
            if source.width < 160 or source.height < 90:
                return content
            image = ImageOps.exif_transpose(source).convert("RGB")
        grayscale = image.convert("L")
        stats = ImageStat.Stat(grayscale)
        mean = float(stats.mean[0])
        deviation = float(stats.stddev[0])
        # Recover the gray veil and clipped-looking indoor covers shown by the
        # affected T8160/T8410/T8441 families. Preserve naturally balanced cards.
        if deviation < 48 or mean < 58 or mean > 198:
            image = ImageOps.autocontrast(image, cutoff=(0.35, 0.35), preserve_tone=True)
            image = ImageEnhance.Contrast(image).enhance(1.10)
            image = ImageEnhance.Color(image).enhance(1.08)
        image = ImageEnhance.Sharpness(image).enhance(1.30)
        output = BytesIO()
        image.save(output, format="JPEG", quality=91, optimize=True, progressive=True)
        result = output.getvalue()
        return result if is_valid_snapshot(result) else content
    except (OSError, TypeError, ValueError):
        return content


def product_snapshot_bytes(product, fallback: bytes | None = None) -> bytes | None:
    """Return a product's verified frame without discarding a valid fallback."""
    try:
        content = product.picture_bytes
    except (KeyError, TypeError, ValueError):
        content = None
    if is_valid_snapshot(content):
        return enhance_dashboard_snapshot(bytes(content))
    return enhance_dashboard_snapshot(bytes(fallback)) if is_valid_snapshot(fallback) else None
