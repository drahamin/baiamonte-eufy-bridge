"""Exercise bounded recovery selection against the actual coordinator method."""
import ast
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def extract(path, name, ns):
    node = next(n for n in ast.walk(ast.parse((ROOT / path).read_text()))
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), path, "exec"), ns)
    return ns[name]


def test_stale_recovery_serializes_homebases_and_reuses_pro_pass_without_live_video():
    async def exercise():
        ns = dict(asyncio=asyncio, datetime=datetime, timedelta=timedelta, timezone=timezone,
                  is_valid_snapshot=lambda b: b == b"image",
                  product_snapshot_bytes=lambda d: d.picture,
                  WebSocketConnectionException=ConnectionError)
        ns["snapshot_needs_recovery"] = extract("custom_components/eufy_security/snapshot.py", "snapshot_needs_recovery", ns)
        refresh = extract("custom_components/eufy_security/coordinator.py", "_refresh_latest_snapshots_unlocked", ns)
        now = datetime.now(timezone.utc)
        def device(serial, station, date, picture=b"image"):
            return SimpleNamespace(serial_no=serial, name=serial, is_camera=True,
                image_last_updated=date, picture=picture, properties={"stationSerialNumber": station})
        devices = {
            "old": device("old", "hb", now-timedelta(days=2)),
            "undated": device("undated", "hb", None),
            "missing": device("missing", "pro", None, b""),
            "recent": device("recent", "hb", now),
        }
        calls, active, maximum = [], {}, {}
        async def search(**kwargs):
            calls.append(kwargs)
            station = kwargs.get("station_serial")
            if station:
                active[station] = active.get(station, 0)+1
                maximum[station] = max(maximum.get(station, 0), active[station])
                await asyncio.sleep(0.001)
                active[station] -= 1
            return {"events": [], "warnings": []}
        coordinator = SimpleNamespace(devices=devices,
            stations={"hb": SimpleNamespace(model="T8030"), "pro": SimpleNamespace(model="T9000")},
            hass=SimpleNamespace(loop=SimpleNamespace(time=lambda: 60)), search_evidence=search,
            _targeted_snapshot_refresh_at={}, _evidence_records={}, _last_snapshot_event_ids={},
            _snapshot_name=lambda n: n.lower(), _valid_snapshot=lambda b: b == b"image",
            _device_channel=lambda d: None)
        result = await refresh(coordinator, source="latest", recover_missing=True)
        assert result["targeted_queries"] == 3
        targeted = [c for c in calls if c.get("device_serial")]
        assert {c["device_serial"] for c in targeted} == {"old", "undated", "missing"}
        assert all(c["days"] == 365 and c["max_results"] == 20 for c in targeted)
        assert next(c for c in targeted if c["device_serial"] == "missing")["source"] == "cloud"
        assert maximum["hb"] == 1
        assert result["scheduled_live_captures"] == 0
        calls.clear()
        again = await refresh(coordinator, source="latest", recover_missing=True)
        assert again["targeted_queries"] == 0
        assert len(calls) == 1
    asyncio.run(exercise())


def test_rejected_thumbnail_does_not_abort_other_camera_updates():
    async def exercise():
        class Rejected(Exception): pass
        ns = dict(asyncio=asyncio, datetime=datetime, timedelta=timedelta, timezone=timezone,
                  product_snapshot_bytes=lambda d: d.picture,
                  snapshot_source_has_capture_time=lambda _:True,
                  FailedCommandException=Rejected, WebSocketConnectionException=ConnectionError,
                  aiohttp=SimpleNamespace(ClientError=OSError))
        refresh = extract("custom_components/eufy_security/coordinator.py", "_refresh_latest_snapshots_unlocked", ns)
        now = datetime.now(timezone.utc)
        old = now-timedelta(days=2)
        events = [{"event_id": key,"thumbnail_url": "/protected/"+key,"start": now.isoformat()} for key in ["bad","good"]]
        devices = {key: SimpleNamespace(serial_no=key,name=key,is_camera=True,picture=b"old",
            image_last_updated=old,snapshot_source="explicit_live_capture",properties={}) for key in ["bad","good"]}
        notified, persisted = [], []
        for key, device in devices.items(): device.notify_state_update=lambda key=key: notified.append(key)
        ns["evidence_identity"] = lambda retained: (retained["serial"],None,None)
        async def search(**kwargs): return {"events":events,"warnings":[]}
        async def thumbnail(key):
            if key == "bad": raise Rejected("device_not_supported")
            return b"new", "image/jpeg"
        c = SimpleNamespace(devices=devices,stations={},hass=SimpleNamespace(loop=SimpleNamespace(time=lambda:60)),
            search_evidence=search,evidence_thumbnail=thumbnail,_targeted_snapshot_refresh_at={},
            _evidence_records={key:{"serial":key} for key in devices},_last_snapshot_event_ids={},
            _snapshot_name=lambda n:(n or "").lower(),_valid_snapshot=lambda b:b in [b"old",b"new"],
            _device_channel=lambda d:None,_schedule_snapshot_cache_write=lambda:persisted.append(True),
            async_set_updated_data=lambda _:None,data={})
        result=await refresh(c,source="latest",recover_missing=False)
        assert result["updated"] == 1 and result["thumbnail_failures"] == 1
        assert notified == ["good"] and persisted
        assert devices["bad"].image_last_updated == old
        assert devices["good"].image_last_updated == now
        assert devices["good"].properties["picture"]["data"] == b"new"
    asyncio.run(exercise())


def test_rejected_pro_image_candidate_falls_through_to_next_picture():
    async def exercise():
        from unittest.mock import AsyncMock
        class Rejected(Exception): pass
        ns=dict(asyncio=asyncio,FailedCommandException=Rejected,WebSocketConnectionException=ConnectionError,
            aiohttp=SimpleNamespace(ClientError=OSError),decode_inline_snapshot=lambda _:b"",
            aic_thumbnail_sources=lambda record:[record])
        thumb=extract("custom_components/eufy_security/coordinator.py","evidence_thumbnail",ns)
        download=AsyncMock(side_effect=[Rejected("device_not_supported"),{"data":b"image","type":{"mime":"image/jpeg"}}])
        record={"station_sn":"pro","thumb_path":"/missing.jpg","crop_path":"/present.jpg"}
        c=SimpleNamespace(_evidence=lambda _: ("aic",record),_valid_snapshot=lambda b:b==b"image",
            _record_field=lambda row,*names:next((row[n] for n in names if row.get(n)),None),
            _buffer_bytes=lambda value:value,stations={"pro":SimpleNamespace(download_image=download)})
        assert await thumb(c,"event") == (b"image","image/jpeg")
        assert download.await_count == 2
    asyncio.run(exercise())


def test_table_fallback_retains_real_dates_and_excludes_other_days():
    ns=dict(datetime=datetime,timezone=timezone)
    within=extract("custom_components/eufy_security/evidence.py","event_in_window",ns)
    start=datetime(2026,11,20,tzinfo=timezone.utc)
    end=datetime(2026,11,21,tzinfo=timezone.utc)
    assert within("2026-11-20T12:00:00Z",start,end)
    assert within("2026-11-20T12:00:00",start,end)
    assert not within("2026-10-20T12:00:00Z",start,end)
    assert not within("2026-11-22T12:00:00Z",start,end)
    assert not within(None,start,end)
    assert not within("invalid",start,end)
