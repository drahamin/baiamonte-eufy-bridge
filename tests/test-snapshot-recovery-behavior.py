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
            hass=SimpleNamespace(loop=asyncio.get_running_loop()), search_evidence=search,
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
