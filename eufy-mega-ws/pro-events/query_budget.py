"""Pure helpers for keeping HomeBase Pro evidence refreshes bounded."""

from __future__ import annotations


def bounded_backfill_serials(
    expected: set[str],
    current: set[str],
    at_seconds: int,
    limit: int = 2,
) -> list[str]:
    """Rotate a small missing-camera backfill slice from day to day.

    A Pro may own many quiet cameras. Querying fifteen years for every missing
    camera serial in one WebRTC session delays current evidence beyond Home
    Assistant's bounded request timeout. A daily rotation preserves eventual
    coverage without turning a read-only refresh into a long camera burst.
    """
    missing = sorted(expected - current)
    safe_limit = max(0, min(int(limit), len(missing)))
    if not safe_limit:
        return []
    offset = (max(0, int(at_seconds)) // 86_400) % len(missing)
    rotated = missing[offset:] + missing[:offset]
    return rotated[:safe_limit]
