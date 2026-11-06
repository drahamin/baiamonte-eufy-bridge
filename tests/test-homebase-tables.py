"""Behavioral checks for startup, bounded roster views and S380 recovery."""
import ast
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace, MethodType
from unittest.mock import AsyncMock

ROOT = Path(__file__).parents[1]
TREE = ast.parse((ROOT / "custom_components/eufy_security/coordinator.py").read_text())


def load(name, namespace):
    node = next(n for n in ast.walk(TREE) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), "coordinator.py", "exec"), namespace)
    return namespace[name]


def test_search_during_startup_returns_warning_without_cloud_or_empty_wait():
    namespace = dict(datetime=datetime, timezone=timezone, timedelta=timedelta)
    search = load("search_evidence", namespace)
    coordinator = SimpleNamespace(available=False, stations={}, _api=None)
    result = asyncio.run(search(coordinator, source="local"))
    assert result["events"] == [] and "initializing" in result["warnings"][0]


def test_roster_is_returned_even_when_no_recording_matches_window():
    async def exercise():
        read = load("homebase_tables", dict(datetime=datetime, timezone=timezone))
        coordinator = SimpleNamespace(
            stations={"hub": SimpleNamespace(serial_no="hub", model="T9000", name="Test Pro")},
            _homebase_rosters={"hub": {"people": [{"name": "Alice", "reference": "opaque", "recognized": True}], "updated_at": "2026-11-01T00:00:00+00:00"}},
            search_evidence=AsyncMock(return_value={"events": [], "warnings": ["table unavailable"]}),
            _link_ha_people=lambda event: event.update(ha_persons=[{"entity_id": "person.alice"}]),
        )
        result = await read(coordinator, days=7)
        assert result["stations"][0]["people"][0]["ha_persons"][0]["entity_id"] == "person.alice"
        assert result["recordings"] == [] and result["warnings"] == ["table unavailable"]
        assert "ha_persons" not in coordinator._homebase_rosters["hub"]["people"][0]
        coordinator.search_evidence.assert_awaited_once_with(source="local", days=7, max_results=200, station_serial="")
    asyncio.run(exercise())


def test_recovery_ignores_old_records_other_cameras_and_existing_person_push():
    async def exercise():
        class Clock:
            @staticmethod
            async def sleep(_seconds): pass
            timeout = asyncio.timeout
            TimeoutError = asyncio.TimeoutError
        namespace = dict(asyncio=Clock, datetime=datetime, timedelta=timedelta, timezone=timezone,
                         local_ai_details=lambda record, **kw: {"person_from_record": record["person"]},
                         normalize_local_event=lambda record: record["event"],
                         WebSocketConnectionException=ConnectionError, _LOGGER=SimpleNamespace(debug=lambda *a: None))
        recover = load("_recover_record_people", namespace)
        now = datetime.now(timezone.utc)
        device = SimpleNamespace(properties={"stationSerialNumber": "hub"}, name="Camera")
        station = SimpleNamespace(model="T8030", database_query_local=AsyncMock(return_value=[
            {"device_sn": "other", "person": True, "event": {"event_id": "other", "start": now.isoformat()}},
            {"device_sn": "cam", "person": True, "event": {"event_id": "old", "start": (now-timedelta(hours=1)).isoformat()}},
            {"device_sn": "cam", "person": False, "event": {"event_id": "motion", "start": now.isoformat()}},
        ]))
        coordinator = SimpleNamespace(_person_recovery_pending={"cam": now}, devices={"cam": device}, stations={"hub": station})
        await recover(coordinator)
        station.database_query_local.assert_awaited_once()
        assert not hasattr(device, "record_person_until")
        coordinator._person_recovery_pending = {"cam": now}
        device.properties["personDetected"] = True
        await recover(coordinator)
        assert station.database_query_local.await_count == 1
    asyncio.run(exercise())


def test_fresh_same_camera_person_record_pulses_once_without_changing_native_state():
    async def exercise():
        class Clock:
            @staticmethod
            async def sleep(_seconds): pass
            timeout = asyncio.timeout
            TimeoutError = asyncio.TimeoutError
        namespace = dict(asyncio=Clock, datetime=datetime, timedelta=timedelta, timezone=timezone,
                         local_ai_details=lambda record, **kw: {"person_from_record": True},
                         normalize_local_event=lambda record: record["event"],
                         WebSocketConnectionException=ConnectionError, _LOGGER=SimpleNamespace(debug=lambda *a: None))
        recover = load("_recover_record_people", namespace)
        now = datetime.now(timezone.utc)
        notifications, events = [], []
        device = SimpleNamespace(properties={"stationSerialNumber": "hub", "personDetected": False}, name="Camera", notify_state_update=lambda: notifications.append(True))
        station = SimpleNamespace(model="T8030", database_query_local=AsyncMock(return_value=[
            {"device_sn": "cam", "event": {"event_id": "fresh", "start": now.isoformat()}},
        ]))
        coordinator = SimpleNamespace(_person_recovery_pending={"cam": now}, devices={"cam": device}, stations={"hub": station},
                                      _person_recovery_seen={}, _person_recovery_resets=set(),
                                      hass=SimpleNamespace(loop=asyncio.get_running_loop(), bus=SimpleNamespace(async_fire=lambda *args: events.append(args))))
        await recover(coordinator)
        assert device.record_person_until > coordinator.hass.loop.time()
        assert not device.properties["personDetected"]
        assert len(events) == 1 and events[0][1]["recognized"] is False
        coordinator._person_recovery_pending = {"cam": now}
        await recover(coordinator)
        assert len(events) == 1
        for handle in coordinator._person_recovery_resets:
            handle.cancel()
    asyncio.run(exercise())
