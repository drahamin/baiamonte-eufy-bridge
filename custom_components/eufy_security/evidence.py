"""Privacy-safe normalization for eufy HomeBase evidence indexes."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any

_AI_FAMILIES = {
    "person": ("person", "human", "body"),
    "face": ("face", "facial", "familiar", "stranger"),
    "vehicle": ("vehicle", "car"),
    "pet": ("pet", "animal", "dog", "cat"),
    "package": ("package", "delivery", "parcel"),
    "sound": ("sound", "audio", "noise"),
    "crying": ("cry", "crying"),
    "motion": ("motion", "radar", "loiter"),
}
_DETECTION_BITS = {
    1: "face",
    2: "person",
    4: "vehicle",
    8: "pet",
    128: "sound",
    256: "crying",
    512: "package",
    1024: "package",
    2048: "package",
}
_STORAGE_NAMES = {0: "unspecified", 1: "local", 2: "cloud", 3: "local_and_cloud"}
_LOCAL_STORAGE_NAMES = {
    0: "unspecified",
    1: "emmc",
    2: "disk",
    3: "sd_card",
    4: "sensor",
    5: "alarm",
}
_PRIVATE_FIELD = re.compile(
    r"(^|_)(account|cipher|credential|did|device_sn|email|imei|imsi|license|"
    r"owner_id|password|path|private|serial|station_sn|token|udid|url|user_id|key)($|_)",
    re.IGNORECASE,
)


def _iso(value: Any) -> str | None:
    """Return a bounded UTC timestamp from seconds, milliseconds, or ISO text."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            seconds = float(value) / 1000 if float(value) > 10_000_000_000 else float(value)
            return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, OSError):
        return None


def _token(*parts: Any) -> str:
    material = ":".join(str(part or "") for part in parts)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


def _truthy_ai_keys(value: Any) -> set[str]:
    """Infer only AI categories; never return identity, URL, coordinates, or confidence."""
    if isinstance(value, str) and len(value) <= 65_536:
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return set()
    found: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            for key, child in list(item.items())[:128]:
                lowered = str(key).lower()
                if child not in (None, False, 0, "", [], {}):
                    for family, words in _AI_FAMILIES.items():
                        if any(word in lowered for word in words):
                            found.add(family)
                if isinstance(child, (dict, list)):
                    visit(child)
        elif isinstance(item, list):
            for child in item[:64]:
                visit(child)

    visit(value)
    return found


def _safe_ai_value(value: Any, *, depth: int = 0) -> Any:
    """Retain useful AI output while removing transport and account internals."""
    if depth > 6:
        return None
    if isinstance(value, str):
        if len(value) > 65_536:
            return None
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value[:1024]
        return _safe_ai_value(parsed, depth=depth + 1)
    if isinstance(value, dict):
        result = {}
        for key, child in list(value.items())[:256]:
            name = str(key)[:128]
            if _PRIVATE_FIELD.search(name):
                continue
            cleaned = _safe_ai_value(child, depth=depth + 1)
            if cleaned is not None:
                result[name] = cleaned
        return result
    if isinstance(value, list):
        return [
            cleaned
            for child in value[:128]
            if (cleaned := _safe_ai_value(child, depth=depth + 1)) is not None
        ]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return str(value)[:1024]


def cloud_ai_details(record: dict[str, Any]) -> dict[str, Any]:
    """Return the complete useful cloud AI result, never its retrieval secrets."""
    faces = record.get("ai_faces") if isinstance(record.get("ai_faces"), list) else []
    return {
        "categories": sorted(
            _truthy_ai_keys(record.get("extra"))
            | ({"person"} if record.get("has_human") else set())
            | ({"face"} if faces else set())
        ),
        "has_human": bool(record.get("has_human")),
        "faces": [
            {
                "position": index + 1,
                "recognition": "stranger" if face.get("is_stranger") else "recognized",
                "has_image": bool(face.get("face_url")),
            }
            for index, face in enumerate(faces[:64])
            if isinstance(face, dict)
        ],
        "analysis": _safe_ai_value(record.get("extra")) or {},
    }


def local_ai_details(record: dict[str, Any]) -> dict[str, Any]:
    """Return HomeBase crop/detection output without paths or numeric identities."""
    pictures = record.get("picture") if isinstance(record.get("picture"), list) else []
    crops = []
    categories: set[str] = set()
    for picture in pictures[:128]:
        if not isinstance(picture, dict):
            continue
        detection = int(picture.get("detection_type") or 0)
        detected = sorted(
            family for bit, family in _DETECTION_BITS.items() if detection & bit
        )
        categories.update(detected)
        crops.append(
            {
                "categories": detected,
                "recognized": bool(picture.get("person_recog_flag")),
                "quality": picture.get("crop_pic_quality"),
                "marked": bool(picture.get("pic_marking_flag")),
                "event_time": _iso(picture.get("event_time")),
                "has_image": bool(picture.get("crop_path")),
            }
        )
    history = record.get("history") if isinstance(record.get("history"), dict) else record
    return {
        "categories": sorted(categories),
        "trigger_type": history.get("trigger_type"),
        "vision": history.get("vision"),
        "self_learning": history.get("self_learning"),
        "crops": crops,
    }


def normalize_cloud_event(record: dict[str, Any]) -> dict[str, Any]:
    """Normalize the cloud account index without exposing transport secrets."""
    faces = record.get("ai_faces") if isinstance(record.get("ai_faces"), list) else []
    categories = _truthy_ai_keys(record.get("extra"))
    if record.get("has_human"):
        categories.add("person")
    if faces:
        categories.add("face")
    start = _iso(record.get("start_time"))
    end = _iso(record.get("end_time"))
    event_id = _token(
        "cloud",
        record.get("station_sn"),
        record.get("device_sn"),
        record.get("monitor_id"),
        record.get("start_time"),
    )
    return {
        "event_id": event_id,
        "source": "account_index",
        "station_name": record.get("station_name") or "HomeBase",
        "device_name": record.get("device_name") or "Camera",
        "start": start,
        "end": end,
        "storage": _STORAGE_NAMES.get(record.get("storage_type"), "other"),
        "video_type": record.get("video_type"),
        "viewed": bool(record.get("viewed")),
        "favorite": bool(record.get("is_favorite")),
        "has_thumbnail": bool(record.get("thumb_path") or record.get("thumb_data")),
        "has_video": bool(
            record.get("storage_path")
            or record.get("hevc_storage_path")
            or record.get("cloud_path")
        ),
        "ai_categories": sorted(categories),
        "recognized_faces": sum(1 for face in faces if not face.get("is_stranger")),
        "stranger_faces": sum(1 for face in faces if face.get("is_stranger")),
    }


def normalize_local_event(record: dict[str, Any]) -> dict[str, Any]:
    """Normalize one S380 local database record."""
    history = record.get("history") if isinstance(record.get("history"), dict) else record
    pictures = record.get("picture") if isinstance(record.get("picture"), list) else []
    categories: set[str] = set()
    for picture in pictures:
        detection = int(picture.get("detection_type") or 0)
        for bit, family in _DETECTION_BITS.items():
            if detection & bit:
                categories.add(family)
    event_id = _token(
        "local",
        record.get("station_sn") or history.get("station_sn"),
        record.get("device_sn") or history.get("device_sn"),
        record.get("record_id"),
        history.get("start_time"),
    )
    return {
        "event_id": event_id,
        "source": "homebase_local",
        "start": _iso(history.get("start_time")),
        "end": _iso(history.get("end_time")),
        "storage": _LOCAL_STORAGE_NAMES.get(history.get("storage_type"), "other"),
        "video_type": history.get("video_type"),
        "trigger_type": history.get("trigger_type"),
        "has_thumbnail": bool(history.get("thumb_path") or pictures),
        "has_video": bool(history.get("storage_path")),
        "ai_categories": sorted(categories),
        "recognized_faces": sum(1 for picture in pictures if picture.get("person_recog_flag")),
        "ai_crops": len(pictures),
    }


def event_merge_key(event: dict[str, Any]) -> tuple[Any, ...]:
    """Deduplicate cloud and local descriptions of the same camera event."""
    return (event.get("device_name"), event.get("start"), event.get("end"))
