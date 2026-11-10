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


def test_failed_capture_retires_its_start_but_does_not_stop_borrowed_stream():
    async def exercise(borrowed):
        status = SimpleNamespace(IDLE="idle", STREAMING="streaming")
        namespace = dict(asyncio=asyncio, contextlib=contextlib, datetime=datetime,
            timedelta=timedelta, timezone=timezone,
            ffmpeg=SimpleNamespace(async_get_image=AsyncMock(return_value=b"invalid")),
            StreamStatus=status, STREAM_TIMEOUT_SECONDS=0.01,
            FailedCommandException=RuntimeError, WebSocketConnectionException=ConnectionError,
            is_valid_snapshot=lambda _: False)
        capture = method("custom_components/eufy_security/camera.py", "async_refresh_stale_snapshot", namespace)
        product = SimpleNamespace(commands=["start_livestream", "stop_livestream"],
            image_last_updated=None, stream_status=status.STREAMING if borrowed else status.IDLE,
            start_livestream=AsyncMock(return_value=False), stop_livestream=AsyncMock())
        class Camera:
            @property
            def is_streaming(self): return product.stream_status == status.STREAMING
        camera = Camera()
        camera.product, camera.hass = product, object()
        camera._scheduled_snapshot_lock = asyncio.Lock()
        camera.stream_source = AsyncMock(return_value="test-source")
        assert not await capture(camera, force=True)
        assert product.stop_livestream.await_count == (0 if borrowed else 1)
        if borrowed: product.start_livestream.assert_not_awaited()
    asyncio.run(exercise(False))
    asyncio.run(exercise(True))


def test_stop_invalidates_pending_start_and_late_event_without_relay_restart():
    async def exercise():
        from collections import deque
        import logging
        status = SimpleNamespace(IDLE="idle", STREAMING="streaming", PREPARING="preparing")
        namespace = dict(asyncio=asyncio, StreamStatus=status,
            StreamProvider=SimpleNamespace(P2P="p2p"), Event=object,
            WebSocketConnectionException=ConnectionError, FailedCommandException=RuntimeError,
            _LOGGER=logging.getLogger("test"))
        path = "custom_components/eufy_security/eufy_security_api/camera.py"
        start = method(path, "start_livestream", namespace)
        stop = method(path, "stop_livestream", namespace)
        late = method(path, "_handle_livestream_started", namespace)
        initiated, release = asyncio.Event(), asyncio.Event()
        async def initiate(_):
            initiated.set()
            await release.wait()
            return True
        checker = asyncio.create_task(asyncio.sleep(60))
        camera = SimpleNamespace(_stream_generation=0, stream_status=status.PREPARING,
            _initiate_start_stream=initiate, p2p_streamer=SimpleNamespace(retry=True, start=AsyncMock()),
            stream_checker=checker, stream_future=None, video_queue=deque([b"old"]), audio_queue=deque(),
            api=SimpleNamespace(stop_livestream=AsyncMock()), product_type="camera", serial_no="test",
            p2p_started_event=asyncio.Event())
        pending = asyncio.create_task(start(camera))
        await initiated.wait()
        await stop(camera)
        release.set()
        assert not await pending
        await asyncio.sleep(0)
        assert checker.cancelled()
        assert camera.p2p_streamer.retry is False
        assert camera.stream_status == status.IDLE
        assert not camera.video_queue
        await late(camera, object())
        assert not camera.p2p_started_event.is_set()
        assert camera.api.stop_livestream.await_count == 2
        camera.p2p_streamer.start.assert_not_awaited()
    asyncio.run(exercise())


def test_old_relay_generation_cannot_feed_a_new_stream():
    async def exercise():
        from collections import deque
        namespace = dict(asyncio=asyncio, STREAM_TIMEOUT_SECONDS=1)
        chunk = method("custom_components/eufy_security/eufy_security_api/p2p_streamer.py", "chunk_generator", namespace)
        relay = SimpleNamespace(retry=None, camera=SimpleNamespace(_stream_generation=2))
        queue = deque([b"old-frame"])
        assert [part async for part in chunk(relay, queue, "video", 1)] == []
        assert list(queue) == [b"old-frame"]
        relay.retry = False
        assert [part async for part in chunk(relay, queue, "video", 2)] == []
    asyncio.run(exercise())


def test_relay_failure_retries_unless_user_stopped_during_request():
    async def exercise(stopped):
        import logging
        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *_): pass
            async def post(self, *_args, **_kwargs):
                if stopped: relay.retry = False
                return SimpleNamespace(status=500)
        namespace = dict(asyncio=asyncio, _LOGGER=logging.getLogger("test"),
            GO2RTC_API_URL="http://{}:{}/api/stream", GO2RTC_API_PORT=1984,
            aiohttp=SimpleNamespace(ClientSession=Session, ClientTimeout=lambda **_: None))
        write = method("custom_components/eufy_security/eufy_security_api/p2p_streamer.py", "write_bytes", namespace)
        relay = SimpleNamespace(retry=None,
            camera=SimpleNamespace(_stream_generation=1, serial_no="test",
                config=SimpleNamespace(rtsp_server_address="local")),
            chunk_generator=lambda *_: None)
        await write(relay, [], "video", 1)
        assert relay.retry is (False if stopped else True)
    asyncio.run(exercise(False))
    asyncio.run(exercise(True))


def test_late_frames_do_not_accumulate_after_stop():
    async def exercise():
        from collections import deque
        status = SimpleNamespace(IDLE="idle", PREPARING="preparing")
        namespace = dict(StreamStatus=status, Event=object)
        receive = method("custom_components/eufy_security/eufy_security_api/camera.py",
            "_handle_livestream_video_data_received", namespace)
        camera = SimpleNamespace(stream_status=status.IDLE, video_queue=deque())
        event = SimpleNamespace(data={"buffer": {"data": [1, 2, 3]}})
        await receive(camera, event)
        assert not camera.video_queue
        camera.stream_status = status.PREPARING
        await receive(camera, event)
        assert list(camera.video_queue) == [bytearray([1, 2, 3])]
    asyncio.run(exercise())


def test_rejected_late_stop_keeps_queued_camera_and_station_events_flowing():
    async def exercise():
        from collections import OrderedDict
        from enum import Enum
        import logging
        namespace = dict(asyncio=asyncio, Enum=Enum, Event=object,
            _LOGGER=logging.getLogger("test"), StreamStatus=SimpleNamespace(IDLE="idle"))
        api_root = ROOT / "custom_components/eufy_security/eufy_security_api"
        for filename, names in [
            ("exceptions.py", {"BaseEufySecurityException", "FailedCommandException", "WebSocketConnectionException"}),
            ("const.py", {"EventNameToHandler"}),
        ]:
            tree = ast.parse((api_root / filename).read_text())
            nodes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name in names]
            exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, "exec"), namespace)
        late = method("custom_components/eufy_security/eufy_security_api/camera.py", "_handle_livestream_started", namespace)
        process = method("custom_components/eufy_security/eufy_security_api/product.py", "process_event", namespace)
        drain = method("custom_components/eufy_security/eufy_security_api/web_socket_client.py", "_process_events", namespace)
        updates, notifications = [], []
        finished = asyncio.Event()
        rejected = namespace["FailedCommandException"]("stop-test", "device_livestream_not_running")
        camera = SimpleNamespace(stream_status="idle", _stream_generation=1,
            api=SimpleNamespace(stop_livestream=AsyncMock(side_effect=rejected)),
            product_type="camera", serial_no="test", p2p_started_event=asyncio.Event(),
            notify_state_update=lambda: notifications.append("camera"))
        camera._handle_livestream_started = MethodType(late, camera)
        async def changed(event):
            updates.append(event.data["target"])
            if len(updates) == 2: finished.set()
        camera._handle_property_changed = changed
        station = SimpleNamespace(_handle_property_changed=changed,
            notify_state_update=lambda: notifications.append("station"))
        async def callback(payload):
            product, event = payload
            await process(product, event)
        queue = OrderedDict(enumerate([
            (camera, SimpleNamespace(type="livestream started", data={})),
            (camera, SimpleNamespace(type="property changed", data={"target": "camera"})),
            (station, SimpleNamespace(type="property changed", data={"target": "station"})),
        ]))
        client = SimpleNamespace(_event_ready=asyncio.Event(), _pending_events=queue,
            message_callback=callback)
        client._event_ready.set()
        worker = asyncio.create_task(drain(client))
        try:
            await asyncio.wait_for(finished.wait(), 0.2)
            await asyncio.sleep(0)
            assert not worker.done()
            assert updates == ["camera", "station"]
            assert notifications == ["camera", "camera", "station"]
            assert not camera.p2p_started_event.is_set()
            assert camera.stream_status == "idle"
            camera.api.stop_livestream.assert_awaited_once()
        finally:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
    asyncio.run(exercise())
