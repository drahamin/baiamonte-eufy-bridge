"""Behavioral checks for capture cleanup and durable-write ordering."""
import ast
import asyncio
import contextlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import MethodType, SimpleNamespace
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
FRESH = b"\xff\xd8\xff" + b"f" * 1500
OLD = b"\xff\xd8\xff" + b"o" * 1500


def method(path, name, namespace):
    tree = ast.parse((ROOT / path).read_text())
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec"), namespace)
    return namespace[name]


def test_capture_publishes_and_commits_after_cleanup_replays_old_picture():
    async def exercise():
        status = SimpleNamespace(IDLE="idle", STREAMING="streaming")
        ffmpeg = SimpleNamespace(async_get_image=AsyncMock(return_value=FRESH))
        namespace = dict(asyncio=asyncio, contextlib=contextlib, datetime=datetime,
            timedelta=timedelta, timezone=timezone, ffmpeg=ffmpeg, StreamStatus=status,
            STREAM_TIMEOUT_SECONDS=1, FailedCommandException=RuntimeError,
            WebSocketConnectionException=ConnectionError, is_valid_snapshot=lambda b: b == FRESH)
        capture = method("custom_components/eufy_security/camera.py", "async_refresh_stale_snapshot", namespace)
        product = SimpleNamespace(commands=["start_livestream", "stop_livestream"],
            image_last_updated=datetime(2026, 1, 1, tzinfo=timezone.utc),
            properties={"picture": {"data": OLD}}, stream_status=status.IDLE,
            notify_state_update=lambda: None)
        order = []
        async def start():
            product.stream_status = status.STREAMING
            return True
        async def stop():
            order.append("cleanup")
            product.stream_status = status.IDLE
            product.properties["picture"] = {"data": OLD}
        async def persist(value):
            assert value.properties["picture"]["data"] == FRESH
            assert value.stream_status == status.IDLE
            await asyncio.sleep(0)
            order.append("persisted")
            return True
        product.start_livestream = start
        product.stop_livestream = stop
        class Camera:
            @property
            def is_streaming(self): return product.stream_status == status.STREAMING
        camera = Camera()
        camera.product, camera.hass = product, object()
        camera._scheduled_snapshot_lock = asyncio.Lock()
        camera.coordinator = SimpleNamespace(async_persist_snapshot_capture=persist)
        camera.stream_source = AsyncMock(return_value="test-source")
        camera.async_update_token = lambda: order.append("token")
        camera.async_write_ha_state = lambda: order.append("published")
        assert await capture(camera, force=True)
        assert order == ["cleanup", "persisted", "token", "published"]
        assert product.properties["picture"]["data"] == FRESH
        assert product.snapshot_source == "explicit_live_capture"
    asyncio.run(exercise())


def test_capture_commit_waits_for_bytes_and_time_and_rejects_stale_or_retired_products():
    async def exercise():
        namespace = dict(asyncio=asyncio, product_snapshot_bytes=lambda d: d.picture_bytes)
        commit = method("custom_components/eufy_security/coordinator.py", "async_persist_snapshot_capture", namespace)
        now = datetime.now(timezone.utc)
        product = SimpleNamespace(serial_no="camera", picture_bytes=FRESH, image_last_updated=now)
        stored = [None]
        async def write():
            await asyncio.sleep(0.01)
            stored[0] = (FRESH, {"updated_at": now.isoformat()})
        coordinator = SimpleNamespace(devices={"camera": product},
            _valid_snapshot=lambda b: b == FRESH, _snapshot_cache_dir="test-dir",
            _snapshot_cache_key=lambda serial: serial,
            _read_snapshot_record=lambda *_args: stored[0])
        def schedule(): coordinator._snapshot_cache_task = asyncio.create_task(write())
        coordinator._schedule_snapshot_cache_write = schedule
        assert await commit(coordinator, product)
        coordinator._schedule_snapshot_cache_write = lambda: setattr(coordinator,
            "_snapshot_cache_task", asyncio.create_task(asyncio.sleep(0)))
        stored[0] = (OLD, {"updated_at": now.isoformat()})
        assert not await commit(coordinator, product)
        stored[0] = (FRESH, {"updated_at": "old"})
        assert not await commit(coordinator, product)
        coordinator.devices["camera"] = object()
        assert not await commit(coordinator, product)
    asyncio.run(exercise())
