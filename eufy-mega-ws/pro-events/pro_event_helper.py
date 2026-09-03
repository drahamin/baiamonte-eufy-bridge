#!/usr/bin/env python3
"""Read HomeBase Professional event thumbnails without starting camera streams."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import random
import re
import struct
import sys
import time
import uuid
from collections.abc import Callable
import truststore
truststore.inject_into_ssl()

from typing import Any

import aiohttp
import websockets
import aiortc.rtcdtlstransport as aiortc_dtls
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp
from aiortc.rtcdtlstransport import RTCCertificate
from OpenSSL import crypto


# HomeBase Pro presents an RSA certificate. aiortc defaults to ECDSA-only
# suites, so add the current browser-compatible RSA suites as well.
_original_ssl_context = RTCCertificate._create_ssl_context


def _compatible_ssl_context(self, srtp_profiles):
    context = _original_ssl_context(self, srtp_profiles)
    context.set_cipher_list(
        b"ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:"
        b"ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:"
        b"ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:"
        b"ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:"
        b"ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA"
    )
    return context


RTCCertificate._create_ssl_context = _compatible_ssl_context


def _validate_raw_peer_identity(self, remote_parameters) -> None:
    """Validate the Pro certificate fingerprint without strict ASN.1 re-parsing.

    Current HomeBase Pro firmware appends bytes to its otherwise valid DER
    certificate. OpenSSL completes DTLS and browsers validate the advertised
    fingerprint, but cryptography's strict X.509 converter rejects the trailing
    data. Hashing the exact peer DER preserves WebRTC fingerprint validation.
    """
    certificate = self._ssl.get_peer_certificate()
    der = crypto.dump_certificate(crypto.FILETYPE_ASN1, certificate)
    supported = 0
    valid = 0
    for fingerprint in remote_parameters.fingerprints:
        algorithm = fingerprint.algorithm.lower()
        digest_name = algorithm.replace("-", "")
        if digest_name not in {"sha256", "sha384", "sha512"}:
            continue
        supported += 1
        digest = hashlib.new(digest_name, der).hexdigest().upper()
        value = ":".join(digest[index : index + 2] for index in range(0, len(digest), 2))
        if fingerprint.value.upper() == value:
            valid += 1
    if not supported or valid != supported:
        self._set_state(aiortc_dtls.State.FAILED)


aiortc_dtls.RTCDtlsTransport._validate_peer_identity = _validate_raw_peer_identity

ROOT = os.path.dirname(os.path.abspath(__file__))
ORACLE = os.environ.get("BAIAMONTE_SCTP_ORACLE", os.path.join(ROOT, "sctp_oracle.cjs"))
NODE = os.environ.get("NODE", "node")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_RESULT_RECORDS = 300


def log(message: str) -> None:
    print(f"[pro-events] {message}", file=sys.stderr, flush=True)


def smart_urls(station_serial: str, region: str) -> tuple[str, str]:
    normalized = (region or "US").strip().lower().split("-", 1)[0]
    suffix = "" if normalized == "us" else f"-{normalized}"
    base = f"https://security-smart{suffix}.eufylife.com"
    return (
        f"{base.replace('https://', 'wss://', 1)}/v1/rtc/ws/join?reqtype=nvr",
        f"{base}/v1/smart/nvr/ws/sign?station_sn={station_serial}",
    )


def build_command(account_id: str, command: int, payload: Any, segment: int) -> bytes:
    body = json.dumps(
        {"account_id": account_id, "cmd": command, "payload": payload},
        separators=(",", ":"),
    ).encode()
    header = bytearray(16)
    header[:4] = b"XZYH"
    struct.pack_into("<H", header, 4, 1350)
    struct.pack_into("<I", header, 6, len(body))
    header[11] = segment & 0xFF
    header[12] = 255
    header[15] = 2
    return bytes(header) + body


def build_event_query(
    account_id: str,
    start_seconds: int,
    end_seconds: int,
    segment: int,
    device_serial: str | None = None,
) -> bytes:
    where: list[dict[str, Any]] = []
    if device_serial:
        where.append({"fields": "device_sn", "operate": "=", "val": device_serial})
    where.append({"fields": "storage_type", "operate": "<=", "val": 3})
    query = {
        "start_date": str(end_seconds),
        "end_date": str(start_seconds),
        "start_id": 0,
        "end_id": 0,
        "query": [],
        "flag": 0,
        "res_unzip": 1,
        "count": 100,
        "where": where,
        "or": [],
        "or_and": [],
        "in_or": {},
        "need_ai": 1,
        "delete_face_flag": 1,
    }
    return build_command(
        account_id,
        1306,
        {
            "cmd": 10066,
            "table": "history_record_info",
            "transaction": str(int(time.time())),
            "payload": query,
        },
        segment,
    )


def build_heartbeat() -> bytes:
    prefix = bytearray(20)
    prefix[1] = 9
    struct.pack_into("<H", prefix, 4, 16)
    prefix[12] = 99
    header = bytearray(16)
    header[:4] = b"XZYH"
    struct.pack_into("<H", header, 4, 1139)
    header[15] = 2
    return bytes(prefix) + bytes(header)


def parse_signal(raw: str | bytes) -> tuple[Any, Any]:
    if isinstance(raw, bytes):
        raw = raw.decode("utf8", "replace")
    outer = json.loads(raw)
    inner = outer.get("data")
    if isinstance(inner, str):
        inner = json.loads(inner)
    data = inner.get("data") if isinstance(inner, dict) else None
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            pass
    return inner, data


def offer_sdp(ice: dict[str, str], setup: str) -> str:
    fingerprint = ":".join(
        ice["fingerprint"][index : index + 2]
        for index in range(0, len(ice["fingerprint"]), 2)
    )
    return (
        "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
        "a=group:BUNDLE 2\r\na=msid-semantic: WMS\r\n"
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
        "c=IN IP4 127.0.0.1\r\na=mid:2\r\na=ice-options:trickle\r\n"
        f"a=ice-ufrag:{ice['ufrag']}\r\na=ice-pwd:{ice['pwd']}\r\n"
        f"a=fingerprint:sha-256 {fingerprint}\r\na=setup:{setup}\r\n"
        "a=sctp-port:5000\r\na=max-message-size:262144\r\n"
    )


def local_ice(sdp: str) -> tuple[str, str, str, list[str]]:
    ufrag = re.search(r"a=ice-ufrag:(\S+)", sdp)
    password = re.search(r"a=ice-pwd:(\S+)", sdp)
    fingerprint = re.search(r"a=fingerprint:sha-256 (\S+)", sdp)
    if not ufrag or not password or not fingerprint:
        raise RuntimeError("WebRTC answer did not contain complete ICE credentials")
    candidates = re.findall(r"a=(candidate:\S[^\r\n]*)", sdp)
    return (
        ufrag.group(1),
        password.group(1),
        fingerprint.group(1).replace(":", ""),
        candidates,
    )


class Oracle:
    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.ready = asyncio.Event()
        self.frames: asyncio.Queue[tuple[int, bytes]] = asyncio.Queue()
        self.send_packet: Callable[[bytes], None] | None = None

    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(
            NODE,
            ORACLE,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=32 * 1024 * 1024,
        )
        asyncio.create_task(self._read_stdout())
        asyncio.create_task(self._read_stderr())
        await asyncio.wait_for(self.ready.wait(), 15)

    async def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        async for line in self.process.stdout:
            try:
                message = json.loads(line)
                event = message.get("event")
                if event == "ready":
                    self.ready.set()
                elif event == "packet" and message.get("source") == "sender" and self.send_packet:
                    self.send_packet(base64.b64decode(message["data"]))
                elif event == "frame":
                    await self.frames.put((int(message.get("link", 0)), base64.b64decode(message["data"])))
                elif event == "error":
                    log("SCTP framing rejected a packet")
            except (ValueError, KeyError):
                continue

    async def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        async for line in self.process.stderr:
            value = line.decode("utf8", "replace").strip()
            if value and "SCTP Version" not in value:
                log(value[:160])

    def _write(self, message: dict[str, str]) -> None:
        if not self.process or not self.process.stdin:
            raise RuntimeError("SCTP framing helper is unavailable")
        self.process.stdin.write((json.dumps(message) + "\n").encode())

    def send(self, frame: bytes) -> None:
        self._write({"operation": "send", "data": base64.b64encode(frame).decode()})

    def receive(self, packet: bytes) -> None:
        self._write({"operation": "receive", "data": base64.b64encode(packet).decode()})

    async def close(self) -> None:
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except asyncio.TimeoutError:
                self.process.kill()


class Signal:
    def __init__(self, websocket, station_serial: str, session_id: str) -> None:
        self.websocket = websocket
        self.station_serial = station_serial
        self.session_id = session_id

    async def send(self, inner: dict[str, Any]) -> None:
        await self.websocket.send(json.dumps({"msgid": str(uuid.uuid4()), "data": json.dumps(inner)}))

    async def join(self) -> None:
        await self.send(
            {
                "code": 200,
                "action": 1,
                "data": self.session_id,
                "sn": self.station_serial,
                "source": "WEB",
                "ts": int(time.time()),
            }
        )

    async def action(self, data_type: str, data: dict[str, Any]) -> None:
        await self.send(
            {
                "code": 200,
                "action": 3,
                "sessionId": self.session_id,
                "sn": self.station_serial,
                "subSn": "",
                "channelId": 0,
                "isResponse": 0,
                "dataType": data_type,
                "source": "WEB",
                "ts": int(time.time()),
                "data": json.dumps(data),
            }
        )

    @staticmethod
    def account() -> str:
        return hashlib.md5(str(random.random()).encode(), usedforsecurity=False).hexdigest()


class EventCollector:
    def __init__(self, config: dict[str, Any], oracle: Oracle) -> None:
        self.config = config
        self.oracle = oracle
        self.account_id = config["accountId"]
        self.expected = {item for item in config.get("expectedDeviceSerials", []) if isinstance(item, str) and item}
        self.pending_filters: list[str] = []
        self.queried_filters: set[str] = set()
        self.latest: dict[str, dict[str, Any]] = {}
        self.records: list[dict[str, Any]] = []
        self.pictures: list[dict[str, Any]] = []
        self.evidence: list[dict[str, Any]] = []
        self.thumbnail_queue: list[tuple[str, str]] = []
        self.thumbnail_by_path: dict[str, str] = {}
        self.thumbnail_responses = 0
        self.thumbnail_images = 0
        self.thumbnail_matches = 0
        self.thumbnail_decoded = 0
        self.done = asyncio.Event()
        self.error: Exception | None = None
        self.segment = 0
        self.phase = "initial"
        self.start_seconds = int(config["startSeconds"])
        self.end_seconds = int(config["endSeconds"])
        self.archive_start = self.end_seconds - 15 * 365 * 24 * 60 * 60

    def next_segment(self) -> int:
        self.segment = (self.segment % 250) + 1
        return self.segment

    def send_initial(self) -> None:
        self.oracle.send(
            build_event_query(
                self.account_id,
                self.start_seconds,
                self.end_seconds,
                self.next_segment(),
            )
        )

    @staticmethod
    def parse_tables(value: Any) -> list[dict[str, Any]]:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                return []
        return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []

    @staticmethod
    def rows(tables: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
        table = next((item for item in tables if item.get("table_name") == name), None)
        payload = table.get("payload") if isinstance(table, dict) else []
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = []
        return [item for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []

    @staticmethod
    def record_time(record: dict[str, Any]) -> int:
        value = record.get("start_utc") or record.get("start_time") or record.get("update_time") or 0
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def add_response(self, response: dict[str, Any]) -> None:
        tables = self.parse_tables(response.get("data"))
        history = self.rows(tables, "history_record_info")
        pictures = self.rows(tables, "record_crop_picture_info")
        smart = self.rows(tables, "smart_search_info")
        for record in history:
            serial = record.get("device_sn")
            if not isinstance(serial, str) or not serial:
                continue
            current = self.latest.get(serial)
            if current is None or self.record_time(record) > self.record_time(current):
                self.latest[serial] = record
        if self.phase == "initial":
            self.records.extend(history[:MAX_RESULT_RECORDS])
            self.pictures.extend(pictures[:MAX_RESULT_RECORDS])
            self.evidence.extend(smart[:MAX_RESULT_RECORDS])
            self.pending_filters = sorted(self.expected - set(self.latest))
            self.phase = "filters"
        elif self.phase == "filters":
            self.records.extend(history[:1])
            if history:
                record_ids = {item.get("record_id") for item in history}
                self.pictures.extend(item for item in pictures if item.get("record_id") in record_ids)
                self.evidence.extend(item for item in smart if item.get("record_id") in record_ids)
        self.send_next_filter_or_thumbnails()

    def send_next_filter_or_thumbnails(self) -> None:
        while self.pending_filters:
            serial = self.pending_filters.pop(0)
            if serial in self.queried_filters:
                continue
            self.queried_filters.add(serial)
            self.oracle.send(
                build_event_query(
                    self.account_id,
                    self.archive_start,
                    self.end_seconds,
                    self.next_segment(),
                    serial,
                )
            )
            return
        self.phase = "thumbnails"
        targets = self.expected if self.expected else set(self.latest)
        for serial in sorted(targets):
            record = self.latest.get(serial)
            path = record.get("thumb_path") if isinstance(record, dict) else None
            if isinstance(path, str) and path and len(path) <= 4096:
                self.thumbnail_queue.append((serial, path))
        self.send_next_thumbnail()

    def send_next_thumbnail(self) -> None:
        if not self.thumbnail_queue:
            self.done.set()
            return
        serial, path = self.thumbnail_queue.pop(0)
        self.thumbnail_by_path[path] = serial
        self.oracle.send(build_command(self.account_id, 1308, [{"file": path}], self.next_segment()))

    def add_thumbnail(self, payload: bytes) -> None:
        self.thumbnail_responses += 1
        try:
            value = json.loads(payload.split(b"\0", 1)[0])
            path = value.get("file")
            content = value.get("content")
            serial = self.thumbnail_by_path.pop(path, None)
            if serial:
                self.thumbnail_matches += 1
            if serial and isinstance(content, str) and 1000 < len(content) <= (MAX_IMAGE_BYTES * 4 // 3) + 16:
                # Firmware inserts line whitespace into larger Base64 payloads.
                # Decode permissively, then enforce a strict size and image-magic
                # allowlist before the bytes can enter the cache.
                encoded = content.split(",", 1)[1] if content.startswith("data:") and "," in content else content
                encoded = "".join(encoded.split())
                encoded += "=" * (-len(encoded) % 4)
                decoded = base64.urlsafe_b64decode(encoded)
                self.thumbnail_decoded += 1
                if len(decoded) <= MAX_IMAGE_BYTES and (
                    decoded.startswith(b"\xff\xd8\xff")
                    or decoded.startswith(b"\x89PNG\r\n\x1a\n")
                    or (decoded.startswith(b"RIFF") and decoded[8:12] == b"WEBP")
                ):
                    record = self.latest.get(serial)
                    if record is not None:
                        record["thumb_data"] = content
                        self.thumbnail_images += 1
        except (ValueError, TypeError, json.JSONDecodeError):
            pass
        self.send_next_thumbnail()

    def result(self) -> dict[str, Any]:
        by_id: dict[Any, dict[str, Any]] = {}
        for record in [*self.records, *self.latest.values()]:
            identity = record.get("record_id")
            by_id[identity if identity is not None else id(record)] = record
        selected_records = list(by_id.values())[:MAX_RESULT_RECORDS]
        selected_ids = {item.get("record_id") for item in selected_records}
        selected_pictures = [item for item in self.pictures if item.get("record_id") in selected_ids][
            :MAX_RESULT_RECORDS
        ]
        selected_evidence = [item for item in self.evidence if item.get("record_id") in selected_ids][
            :MAX_RESULT_RECORDS
        ]
        return {
            "record_list": selected_records,
            "eventRecordList": [],
            "recordPictureList": selected_pictures,
            "evidenceRecordList": selected_evidence,
        }


async def sign_token(url: str, headers: dict[str, str]) -> str:
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=20)) as response:
            raw = (await response.text()).strip()
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = raw
            token = body.get("data") if isinstance(body, dict) else body if isinstance(body, str) else None
            if response.status != 200 or not isinstance(token, str) or not token:
                raise RuntimeError("HomeBase Pro WebRTC sign request was rejected")
            if len(token) > 4096 or re.fullmatch(r"[A-Za-z0-9._~+/%=-]{8,4096}", token) is None:
                raise RuntimeError("HomeBase Pro WebRTC sign response was invalid")
            return token


async def run(config: dict[str, Any]) -> dict[str, Any]:
    persistent_path = config.get("persistentPath")
    if not isinstance(persistent_path, str) or not persistent_path:
        raise ValueError("Persistent session path is required")
    with open(persistent_path, encoding="utf8") as stream:
        persistent = json.load(stream)
    mega = persistent.get("megaApi") if isinstance(persistent.get("megaApi"), dict) else {}
    token = mega.get("cloud_token") or persistent.get("cloud_token")
    user_id = mega.get("user_id") or (persistent.get("httpApi") or {}).get("user_id")
    station_serial = config.get("stationSn")
    if not all(isinstance(item, str) and item for item in (token, user_id, station_serial, config.get("accountId"))):
        raise RuntimeError("HomeBase Pro event authentication is incomplete")

    region = str(config.get("region") or "US")
    websocket_url, sign_url = smart_urls(station_serial, region)
    headers = {
        "X-Auth-Token": token,
        "GToken": hashlib.md5(user_id.encode(), usedforsecurity=False).hexdigest(),
        "App-Name": "eufy_mega",
        "Model-Type": "WEB",
        "Web-Country": region,
        "User-Agent": USER_AGENT,
        "Origin": "https://security.eufy.com",
        "Referer": "https://security.eufy.com/",
    }
    signed = await sign_token(sign_url, headers)
    oracle = Oracle()
    await oracle.start()
    collector = EventCollector(config, oracle)
    peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    channels: dict[str, Any] = {}
    connected = False
    command_open = False
    started = False

    def maybe_start() -> None:
        nonlocal started
        if connected and command_open and not started:
            started = True
            oracle.send(build_command(collector.account_id, 9100, {}, collector.next_segment()))

            async def delayed_query() -> None:
                await asyncio.sleep(1)
                collector.send_initial()

            asyncio.create_task(delayed_query())

    def send_packet(packet: bytes) -> None:
        channel = channels.get("WebrtcDataChannel")
        if channel and channel.readyState == "open":
            channel.send(packet)

    oracle.send_packet = send_packet

    def attach(channel) -> None:
        @channel.on("open")
        def opened() -> None:
            nonlocal command_open
            if channel.label == "WebrtcDataChannel":
                command_open = True
                maybe_start()

        @channel.on("message")
        def message_received(message) -> None:
            packet = bytes(message) if isinstance(message, (bytes, bytearray)) else str(message).encode()
            if packet.startswith(b"PTCS"):
                oracle.receive(packet)

    @peer.on("datachannel")
    def data_channel(channel) -> None:
        attach(channel)

    @peer.on("connectionstatechange")
    async def connection_changed() -> None:
        nonlocal connected
        if peer.connectionState == "connected":
            connected = True
            maybe_start()
        elif peer.connectionState in {"failed", "closed"} and not collector.done.is_set():
            collector.error = RuntimeError("HomeBase Pro WebRTC connection closed")
            collector.done.set()

    async def consume_frames() -> None:
        while not collector.done.is_set():
            _link, frame = await oracle.frames.get()
            if len(frame) < 16 or frame[:4] != b"XZYH":
                continue
            command = struct.unpack_from("<H", frame, 4)[0]
            payload = frame[16:]
            if command == 1350 and len(payload) >= 4:
                result = struct.unpack_from("<i", payload, 0)[0]
                if result < 0:
                    collector.error = RuntimeError(f"HomeBase Pro rejected command ({result})")
                    collector.done.set()
            elif command == 1306:
                try:
                    response = json.loads(payload.split(b"\0", 1)[0])
                    if response.get("mIntRet", 0) != 0:
                        raise RuntimeError("HomeBase Pro event query failed")
                    collector.add_response(response)
                except (ValueError, TypeError, json.JSONDecodeError) as error:
                    collector.error = RuntimeError("HomeBase Pro returned invalid event data")
                    collector.error.__cause__ = error
                    collector.done.set()
            elif command == 1308:
                collector.add_thumbnail(payload)

    consumer = asyncio.create_task(consume_frames())
    heartbeat: asyncio.Task | None = None
    session_id = signed
    subscription = {
        "region": region,
        "type": "NVR",
        "sn": station_serial,
        "token": token,
        "gtoken": headers["GToken"],
        "sign": signed,
        "appName": "eufy_mega",
        "modelType": "WEB",
    }
    subprotocol = base64.urlsafe_b64encode(json.dumps(subscription, separators=(",", ":")).encode()).decode().rstrip("=")

    try:
        async with websockets.connect(
            websocket_url,
            subprotocols=["v1", subprotocol],
            additional_headers={"Origin": "https://security.eufy.com"},
            user_agent_header=USER_AGENT,
            max_size=4 * 1024 * 1024,
        ) as websocket:
            signal = Signal(websocket, station_serial, session_id)
            await signal.join()
            answered = False
            pending_candidates: list[str] = []

            async def heartbeat_loop() -> None:
                await asyncio.sleep(0.5)
                packet = build_heartbeat()
                while not collector.done.is_set():
                    channel = channels.get("WebrtcDataChannel")
                    if channel and channel.readyState == "open":
                        channel.send(packet)
                    await asyncio.sleep(10)

            async def add_candidate(value: str) -> None:
                candidate = candidate_from_sdp(value.split(":", 1)[1])
                candidate.sdpMid = "2"
                candidate.sdpMLineIndex = 0
                await peer.addIceCandidate(candidate)

            async def receive_signals() -> None:
                nonlocal answered, heartbeat
                async for raw in websocket:
                    inner, data = parse_signal(raw)
                    if not isinstance(inner, dict):
                        continue
                    if inner.get("action") == 1:
                        await signal.action("scall", {"timestamp": int(time.time()), "account": signal.account()})
                    elif inner.get("action") == 3 and isinstance(data, dict):
                        if data.get("format") == "SDP" and not answered:
                            answered = True
                            value = data["value"]
                            if isinstance(value, str):
                                value = json.loads(value)
                            await peer.setRemoteDescription(
                                RTCSessionDescription(
                                    sdp=offer_sdp(value["ice"], value.get("setup", "actpass")),
                                    type="offer",
                                )
                            )
                            for label in ("WebrtcDataChannel", "audio", "idr", "video", "notify", "download"):
                                channels[label] = peer.createDataChannel(label)
                                attach(channels[label])
                            answer = await peer.createAnswer()
                            await peer.setLocalDescription(answer)
                            ufrag, password, fingerprint, candidates = local_ice(peer.localDescription.sdp)
                            await signal.action("ack", {"timestamp": int(time.time()), "account": signal.account()})
                            await signal.action(
                                "info",
                                {
                                    "timestamp": int(time.time()),
                                    "account": signal.account(),
                                    "sdp": json.dumps(
                                        {
                                            "ice": {
                                                "ufrag": ufrag,
                                                "pwd": password,
                                                "fingerprint": fingerprint.upper(),
                                                "fingerprint_type": "sha-256",
                                            },
                                            "setup": "active",
                                        }
                                    ),
                                },
                            )
                            for candidate in candidates:
                                await signal.action(
                                    "info",
                                    {"timestamp": int(time.time()), "account": signal.account(), "candidate": candidate},
                                )
                            for candidate in pending_candidates:
                                await add_candidate(candidate)
                            pending_candidates.clear()
                            heartbeat = asyncio.create_task(heartbeat_loop())
                        elif data.get("format") == "CANDIDATE":
                            candidate = data.get("value")
                            if isinstance(candidate, str):
                                if not answered or peer.remoteDescription is None:
                                    pending_candidates.append(candidate)
                                else:
                                    await add_candidate(candidate)

            receiver = asyncio.create_task(receive_signals())
            await asyncio.wait_for(collector.done.wait(), timeout=55)
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
    finally:
        if heartbeat:
            heartbeat.cancel()
        consumer.cancel()
        await asyncio.gather(consumer, return_exceptions=True)
        await peer.close()
        await oracle.close()
    if collector.error:
        raise collector.error
    return {
        "data": collector.result(),
        "liveStreamsStarted": 0,
        "thumbnailResponses": collector.thumbnail_responses,
        "thumbnailMatches": collector.thumbnail_matches,
        "thumbnailDecoded": collector.thumbnail_decoded,
        "thumbnailImages": collector.thumbnail_images,
    }


async def main() -> None:
    config = json.load(sys.stdin)
    result = await run(config)
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        log(type(error).__name__)
        raise SystemExit(1) from error
