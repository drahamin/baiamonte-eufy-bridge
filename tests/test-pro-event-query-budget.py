#!/usr/bin/env python3
"""Dependency-free tests for bounded HomeBase Pro history backfill."""

import ast
import asyncio
import json
from pathlib import Path
import struct
import time
from typing import Any


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

WIRE_FUNCTIONS = [
    node
    for node in TREE.body
    if isinstance(node, ast.FunctionDef)
    and node.name in {"build_command", "build_table_query"}
]
WIRE_NAMESPACE = {"json": json, "struct": struct, "time": time, "Any": Any, "MAX_PERSON_RECORDS": 500}
exec(
    compile(ast.Module(body=WIRE_FUNCTIONS, type_ignores=[]), str(HELPER_PATH), "exec"),
    WIRE_NAMESPACE,
)

COLLECTOR_FUNCTIONS = [
    node
    for node in TREE.body
    if isinstance(node, ast.FunctionDef)
    and node.name in {"bounded_backfill_serials", "build_command", "build_event_query", "build_table_query"}
]
COLLECTOR_CLASS = next(
    node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "EventCollector"
)
COLLECTOR_NAMESPACE = {
    "asyncio": asyncio,
    "json": json,
    "struct": struct,
    "time": time,
    "Any": Any,
    "Oracle": object,
    "MAX_IMAGE_BYTES": 10 * 1024 * 1024,
    "MAX_RESULT_RECORDS": 300,
    "MAX_PERSON_RECORDS": 500,
    "MAX_THUMBNAIL_IN_FLIGHT": 4,
    "THUMBNAIL_RESPONSE_SECONDS": 3,
    "LIVE_QUERY_BACKFILL_SERIALS": 0,
}
exec(
    compile(
        ast.Module(body=[*COLLECTOR_FUNCTIONS, COLLECTOR_CLASS], type_ignores=[]),
        str(HELPER_PATH),
        "exec",
    ),
    COLLECTOR_NAMESPACE,
)


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


def test_live_query_does_not_block_on_optional_archive_backfills() -> None:
    source = HELPER_PATH.read_text(encoding="utf-8")
    assert "LIVE_QUERY_BACKFILL_SERIALS = 0" in source
    assert "LIVE_QUERY_BACKFILL_SERIALS," in source


def test_pro_helper_reads_face_roster_before_events_without_live_video() -> None:
    source = HELPER_PATH.read_text(encoding="utf-8")
    assert 'build_table_query(self.account_id, "person_basic_info"' in source
    assert '"personBasicInfoList": self.people[:MAX_PERSON_RECORDS]' in source
    assert '"liveStreamsStarted": 0' in source
    assert "ROSTER_RESPONSE_SECONDS = 3" in source
    assert "collector.skip_optional_roster()" in source


def test_late_roster_response_cannot_advance_event_query_state() -> None:
    class FakeOracle:
        def __init__(self) -> None:
            self.frames: list[bytes] = []

        def send(self, frame: bytes) -> None:
            self.frames.append(frame)

    oracle = FakeOracle()
    collector = COLLECTOR_NAMESPACE["EventCollector"](
        {
            "accountId": "account",
            "expectedDeviceSerials": [],
            "startSeconds": 1,
            "endSeconds": 2,
        },
        oracle,
    )
    collector.send_initial()
    collector.skip_optional_roster()
    assert collector.phase == "initial"
    assert len(oracle.frames) == 2

    collector.add_response(
        {
            "data": [
                {
                    "table_name": "person_basic_info",
                    "payload": [{"person_id": "1", "name": "Person"}],
                }
            ]
        }
    )
    assert collector.phase == "initial"
    assert len(oracle.frames) == 2
    assert len(collector.people) == 1

    collector.add_response({"data": [{"table_name": "history_record_info", "payload": []}]})
    assert collector.phase == "thumbnails"
    assert collector.done.is_set()


def test_thumbnail_reads_are_bounded_and_one_timeout_does_not_block_the_batch() -> None:
    class FakeOracle:
        def __init__(self) -> None:
            self.frames: list[bytes] = []

        def send(self, frame: bytes) -> None:
            self.frames.append(frame)

    async def exercise() -> None:
        oracle = FakeOracle()
        collector = COLLECTOR_NAMESPACE["EventCollector"](
            {
                "accountId": "account",
                "expectedDeviceSerials": [],
                "startSeconds": 1,
                "endSeconds": 2,
            },
            oracle,
        )
        collector.thumbnail_queue = [(f"camera-{index}", f"path-{index}") for index in range(6)]
        collector.send_next_thumbnail()
        assert len(oracle.frames) == 4
        assert len(collector.thumbnail_by_path) == 4
        assert len(collector.thumbnail_queue) == 2

        collector.thumbnail_timed_out("path-0")
        assert len(oracle.frames) == 5
        assert len(collector.thumbnail_by_path) == 4
        assert len(collector.thumbnail_queue) == 1

        for handle in collector.thumbnail_timeouts.values():
            handle.cancel()

    asyncio.run(exercise())


def test_person_roster_uses_the_bounded_homebase_table_wire_shape() -> None:
    frame = WIRE_NAMESPACE["build_table_query"]("account", "person_basic_info", 7)
    assert frame[:4] == b"XZYH"
    assert struct.unpack_from("<H", frame, 4)[0] == 1350
    body = json.loads(frame[16:])
    assert body["cmd"] == 1306
    assert body["payload"]["cmd"] == 10000
    assert body["payload"]["table"] == "person_basic_info"
    assert body["payload"]["payload"]["count"] == 500


if __name__ == "__main__":
    test_backfill_is_bounded_and_excludes_current_cameras()
    test_backfill_rotates_without_duplicates()
    test_empty_or_zero_limit_backfill_is_safe()
