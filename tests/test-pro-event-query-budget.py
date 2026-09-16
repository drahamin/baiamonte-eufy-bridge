#!/usr/bin/env python3
"""Dependency-free tests for bounded HomeBase Pro history backfill."""

import ast
from pathlib import Path


HELPER_PATH = (
    Path(__file__).resolve().parents[1]
    / "eufy-mega-ws"
    / "pro-events"
    / "pro_event_helper.py"
)
TREE = ast.parse(HELPER_PATH.read_text(encoding="utf-8"))
FUNCTION = next(
    node
    for node in TREE.body
    if isinstance(node, ast.FunctionDef) and node.name == "bounded_backfill_serials"
)
NAMESPACE: dict = {}
exec(compile(ast.Module(body=[FUNCTION], type_ignores=[]), str(HELPER_PATH), "exec"), NAMESPACE)
bounded_backfill_serials = NAMESPACE["bounded_backfill_serials"]


def test_backfill_is_bounded_and_excludes_current_cameras() -> None:
    selected = bounded_backfill_serials(
        {"camera-a", "camera-b", "camera-c", "camera-d"},
        {"camera-a"},
        0,
    )
    assert selected == ["camera-b", "camera-c"]


def test_backfill_rotates_without_duplicates() -> None:
    expected = {"camera-a", "camera-b", "camera-c", "camera-d"}
    first = bounded_backfill_serials(expected, set(), 0)
    second = bounded_backfill_serials(expected, set(), 86_400)
    assert first == ["camera-a", "camera-b"]
    assert second == ["camera-b", "camera-c"]
    assert len(set(first)) == len(first)
    assert len(set(second)) == len(second)


def test_empty_or_zero_limit_backfill_is_safe() -> None:
    assert bounded_backfill_serials({"camera-a"}, {"camera-a"}, 0) == []
    assert bounded_backfill_serials({"camera-a"}, set(), 0, limit=0) == []


if __name__ == "__main__":
    test_backfill_is_bounded_and_excludes_current_cameras()
    test_backfill_rotates_without_duplicates()
    test_empty_or_zero_limit_backfill_is_safe()
