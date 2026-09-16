#!/usr/bin/env python3
"""Dependency-free tests for bounded HomeBase Pro history backfill."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "eufy-mega-ws"
    / "pro-events"
    / "query_budget.py"
)
SPEC = spec_from_file_location("baiamonte_query_budget", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_backfill_is_bounded_and_excludes_current_cameras() -> None:
    selected = MODULE.bounded_backfill_serials(
        {"camera-a", "camera-b", "camera-c", "camera-d"},
        {"camera-a"},
        0,
    )
    assert selected == ["camera-b", "camera-c"]


def test_backfill_rotates_without_duplicates() -> None:
    expected = {"camera-a", "camera-b", "camera-c", "camera-d"}
    first = MODULE.bounded_backfill_serials(expected, set(), 0)
    second = MODULE.bounded_backfill_serials(expected, set(), 86_400)
    assert first == ["camera-a", "camera-b"]
    assert second == ["camera-b", "camera-c"]
    assert len(set(first)) == len(first)
    assert len(set(second)) == len(second)


def test_empty_or_zero_limit_backfill_is_safe() -> None:
    assert MODULE.bounded_backfill_serials({"camera-a"}, {"camera-a"}, 0) == []
    assert MODULE.bounded_backfill_serials({"camera-a"}, set(), 0, limit=0) == []


if __name__ == "__main__":
    test_backfill_is_bounded_and_excludes_current_cameras()
    test_backfill_rotates_without_duplicates()
    test_empty_or_zero_limit_backfill_is_safe()
