"""Pro still framing, real HEVC/JPEG decoding, busy refusal and cache guarantees."""
import ast
import asyncio
import base64
import io
import json
import struct
import time
from datetime import datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import av
import pytest

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / 'eufy-mega-ws/pro-events/pro_event_helper.py'
TREE = ast.parse(PATH.read_text())
NAMES = {'build_command', 'build_live_command', 'parse_live_media', 'encode_live_still',
         'build_table_query', 'build_event_query', 'bounded_backfill_serials', 'codec_selftest'}
NAMESPACE = dict(asyncio=asyncio, base64=base64, json=json, struct=struct, time=time,
                 datetime=datetime, timezone=timezone, Fraction=Fraction, Any=Any, Oracle=object,
                 MAX_IMAGE_BYTES=10*1024*1024, MAX_RESULT_RECORDS=300, MAX_PERSON_RECORDS=500,
                 MAX_THUMBNAIL_IN_FLIGHT=4, THUMBNAIL_RESPONSE_SECONDS=3, LIVE_QUERY_BACKFILL_SERIALS=0,
                 __file__=str(PATH))
NODES = [n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name in NAMES or
         isinstance(n, ast.ClassDef) and n.name in {'EventCollector', 'SnapshotCollector'}]
exec(compile(ast.Module(body=NODES, type_ignores=[]), str(PATH), 'exec'), NAMESPACE)


class Oracle:
    def __init__(self): self.frames = []
    def send(self, frame): self.frames.append(frame)


def collector():
    oracle = Oracle()
    result = NAMESPACE['SnapshotCollector'](
        dict(accountId='account', cameraChannel=7, startSeconds=1, endSeconds=2), oracle)
    return result, oracle


def video_packet(data, *, codec=1, channel=101):
    media = bytearray(22)
    struct.pack_into('<I', media, 0, len(data)); media[5] = codec
    struct.pack_into('<HH', media, 10, 64, 48)
    header = bytearray(16); header[:4] = b'XZYH'
    struct.pack_into('<H', header, 4, 1300)
    struct.pack_into('<I', header, 6, len(media)+len(data)); header[12] = channel
    return bytes(header+media)+data


def test_play_slot_wire_matches_pro_rtc_not_p2p():
    c, o = collector(); c.send_initial(); c.stop(); c.stop()
    assert len(o.frames) == 2
    for frame, command in zip(o.frames, [1003, 1004]):
        assert frame[:4] == b'XZYH'
        assert struct.unpack_from('<H', frame, 4)[0] == 1350
        assert frame[12] == 255 and frame[14] == 1
        payload = json.loads(frame[16:]); assert payload['cmd'] == command
    start = json.loads(o.frames[0][16:])['payload']
    assert start['ClientOS'] == 'WEB' and start['streamtype'] == 2 and start['play_id'] == 1
    assert start['chn_list'] == [dict(index=0, chn=7, sensor=0, isUps=0, isClicked=True)]
    assert json.loads(o.frames[1][16:])['payload'] == {}


@pytest.mark.parametrize('channel', [-1, 255, True, '7', None, 1.5])
def test_non_camera_channels_never_start(channel):
    with pytest.raises(ValueError):
        NAMESPACE['build_live_command']('account', channel, 1)


def test_bad_media_never_reaches_decoder():
    parse = NAMESPACE['parse_live_media']; good = video_packet(b'hevc')
    assert parse(good, 5) == b'hevc'
    for frame, link in [(good, 3), (good[:-1], 5), (video_packet(b'hevc', codec=0), 5),
                        (video_packet(b'hevc', channel=102), 5), (b'bad', 5)]:
        assert parse(frame, link) is None
    oversized = bytearray(good); struct.pack_into('<I', oversized, 16, 4*1024*1024+1)
    assert parse(oversized, 5) is None
    oversized = bytearray(good); struct.pack_into('<H', oversized, 26, 8192)
    assert parse(oversized, 5) is None


def test_refused_start_never_stops_somebody_elses_play_slot():
    c, o = collector(); c.send_initial()
    ack = bytearray(20); ack[:4] = b'XZYH'; struct.pack_into('<H', ack, 4, 1350)
    struct.pack_into('<I', ack, 6, 4); ack[14] = 1; ack[11] = c.start_segment + 1
    struct.pack_into('<i', ack, 16, 5)
    c.add_ack(bytes(ack), 1); assert not c.done.is_set()
    ack[11] = c.start_segment
    c.add_ack(bytes(ack), 1); assert c.done.is_set() and c.start_refused
    c.stop(); assert len(o.frames) == 1


@pytest.mark.parametrize("with_ack", [True, False])
def test_real_hevc_frame_becomes_a_full_size_jpeg_and_releases_slot(with_ack):
    async def exercise():
        c, o = collector()
        ack = bytearray(20); ack[:4] = b'XZYH'
        struct.pack_into('<H', ack, 4, 1350); struct.pack_into('<I', ack, 6, 4)
        ack[14] = 1
        await c.add_media(video_packet(b'before our start'), 5)
        assert c.media_frames == 0 and c.image is None
        c.send_initial(); ack[11] = c.start_segment
        if with_ack:
            c.add_ack(bytes(ack), 1); assert c.start_accepted
        parser = av.CodecContext.create('hevc', 'r')
        raw = (PATH.parent/'fixtures/pro-still.hevc').read_bytes()
        for packet in [*parser.parse(raw), *parser.parse(b'')]:
            await c.add_media(video_packet(bytes(packet)), 5)
            if c.done.is_set(): break
        assert c.error is None and c.image and c.captured_at
        c.stop(); assert json.loads(o.frames[-1][16:])['cmd'] == 1004
        result = c.result()['snapshot']
        with av.open(io.BytesIO(base64.b64decode(result['data']))) as image:
            frame = next(image.decode(video=0)); assert (frame.width, frame.height) == (64, 48)
        assert result['mimeType'] == 'image/jpeg'
        assert datetime.now(timezone.utc) - datetime.fromisoformat(result['capturedAt']) < timedelta(seconds=2)
    asyncio.run(exercise())


def test_build_time_codec_selftest():
    NAMESPACE['codec_selftest']()


def extracted_method(name, namespace, path='custom_components/eufy_security/camera.py'):
    node = next(n for n in ast.walk(ast.parse((ROOT/path).read_text()))
                if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), 'exec'), namespace)
    return namespace[name]


def test_pro_capture_commits_current_pixels_without_any_p2p_start():
    async def exercise():
        fresh = b'\xff\xd8\xff'+b'x'*1500; old = b'old'
        now = datetime.now(timezone.utc)
        status = SimpleNamespace(IDLE='idle', STREAMING='streaming')
        ns = dict(asyncio=asyncio, base64=base64, datetime=datetime, timezone=timezone,
                  timedelta=timedelta, StreamStatus=status, is_valid_snapshot=lambda b:b==fresh,
                  FailedCommandException=RuntimeError, WebSocketConnectionException=ConnectionError)
        method = extracted_method('_capture_pro_snapshot', ns)
        product = SimpleNamespace(serial_no='camera', properties={'stationSerialNumber':'pro','picture':{'data':old}},
                                  stream_status='idle', notify_state_update=lambda:None)
        request = AsyncMock(return_value=dict(data=base64.b64encode(fresh).decode(),capturedAt=now.isoformat()))
        persist = AsyncMock(return_value=True)
        coordinator = SimpleNamespace(_pro_evidence_lock=asyncio.Lock(),devices={'camera':product},
            _api=SimpleNamespace(capture_live_snapshot=request),async_persist_snapshot_capture=persist)
        camera = SimpleNamespace(coordinator=coordinator,product=product,_scheduled_snapshot_lock=asyncio.Lock(),
            async_update_token=lambda:None,async_write_ha_state=lambda:None)
        assert await method(camera,SimpleNamespace(serial_no='pro'))
        assert product.properties['picture']['data'] == fresh and product.image_last_updated == now
        assert product.snapshot_source == 'explicit_live_capture:homebase_pro_rtc'
        persist.assert_awaited_once_with(product)
        product.stream_status='streaming'; request.reset_mock()
        assert not await method(camera,SimpleNamespace(serial_no='pro'))
        request.assert_not_awaited()
        product.stream_status='idle'
        await coordinator._pro_evidence_lock.acquire()
        assert not await method(camera,SimpleNamespace(serial_no='pro'))
        coordinator._pro_evidence_lock.release(); request.assert_not_awaited()
        request.side_effect=ConnectionError('failed')
        assert not await method(camera,SimpleNamespace(serial_no='pro'))
        assert product.image_last_updated == now and product.properties['picture']['data'] == fresh
        assert not coordinator._pro_evidence_lock.locked()
    asyncio.run(exercise())


def test_send_failure_does_not_leak_a_pending_response_future():
    async def exercise():
        ns=dict(asyncio=asyncio,OutgoingMessage=object,WebSocketConnectionException=ConnectionError)
        method=extracted_method('_send_message_get_response',ns,
                                'custom_components/eufy_security/eufy_security_api/api_client.py')
        client=SimpleNamespace(_result_futures={},send_message=AsyncMock(side_effect=ConnectionError('closed')))
        with pytest.raises(ConnectionError):
            await method(client,SimpleNamespace(id='request',content={}))
        assert client._result_futures == {}
    asyncio.run(exercise())


def test_pro_routing_does_not_require_legacy_p2p_commands():
    async def exercise():
        ns=dict(datetime=datetime,timedelta=timedelta,timezone=timezone)
        capture=extracted_method('async_refresh_stale_snapshot',ns)
        station=SimpleNamespace(model='T9000')
        call=AsyncMock(return_value=True)
        camera=SimpleNamespace(product=SimpleNamespace(image_last_updated=None,commands=[],
                   properties={'stationSerialNumber':'pro'}),coordinator=SimpleNamespace(stations={'pro':station}),
                   _capture_pro_snapshot=call)
        assert await capture(camera,force=True)
        call.assert_awaited_once_with(station)
        call.reset_mock()
        assert not await capture(camera,force=False)
        call.assert_not_awaited()
    asyncio.run(exercise())
