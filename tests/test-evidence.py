"""Small dependency-free tests for the evidence privacy boundary."""

from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE = Path(__file__).parents[1] / "custom_components/eufy_security/evidence.py"
SPEC = importlib.util.spec_from_file_location("baiamonte_evidence", MODULE)
assert SPEC and SPEC.loader
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)


def test_cloud_ai_details() -> None:
    """Useful recognition results survive while retrieval fields do not."""
    result = evidence.cloud_ai_details(
        {
            "has_human": 1,
            "ai_faces": [
                {
                    "is_stranger": 1,
                    "face_url": "https://example.invalid/secret",
                    "owner_id": "private",
                }
            ],
            "extra": (
                '{"person_name":"Alice","confidence":0.96,'
                '"face_url":"private","box":{"x":1,"y":2},"tracking":true}'
            ),
        }
    )
    assert result["analysis"]["person_name"] == "Alice"
    assert result["analysis"]["confidence"] == 0.96
    assert result["analysis"]["box"] == {"x": 1, "y": 2}
    assert result["recognized_people"] == ["Alice"]
    assert "face_url" not in result["analysis"]
    assert result["faces"] == [
        {"position": 1, "recognition": "stranger", "has_image": True}
    ]


def test_roster_exposes_names_without_identity_templates_or_media_secrets():
    rows = [{"person_id": 7, "name": "Alice", "face_data": "secret", "face_path": "/private", "token": "secret"},
            {"person_id": 7, "name": "duplicate"}, {"person_id": 8, "name": "stranger42"}, {}, None]
    roster = evidence.normalize_face_roster(rows, "hub-a")
    assert len(roster) == 2
    assert roster[0]["name"] == "Alice" and roster[0]["recognized"]
    assert not roster[1]["recognized"]
    assert set(roster[0]) == {"reference", "name", "recognized"}
    assert roster[0]["reference"] != evidence.normalize_face_roster(rows, "hub-b")[0]["reference"]


def test_s380_recording_classification_is_opt_in_and_does_not_invent_identity():
    row = {"history": {"trigger_type": 4}}
    assert evidence.local_ai_details(row)["categories"] == []
    result = evidence.local_ai_details(row, s380_person_from_record=True)
    assert result["categories"] == ["person"] and result["person_from_record"]
    assert "recognized_people" not in result
    assert evidence.local_ai_details({"trigger_type": 2}, s380_person_from_record=True)["categories"] == []


def test_old_record_does_not_borrow_new_same_camera_cover():
    old = {"record_id": 10, "thumb_path": "/old"}
    latest = {"record_id": 11, "thumb_path": "/new", "thumb_data": "new-pixels"}
    record = {"history": old, "latest_update": {"event": latest, "snapshot_cloud": "new-url"}}
    assert evidence.aic_thumbnail_sources(record) == [old]
    record["latest_update"]["event"] = {**latest, "record_id": 10}
    assert evidence.aic_thumbnail_sources(record)[1]["thumb_data"] == "new-pixels"


def test_record_id_mismatch_wins_over_a_reused_path():
    record = {"history": {"record_id": 1, "thumb_path": "/cover"},
              "latest_update": {"event": {"record_id": 2, "thumb_path": "/cover"}}}
    assert len(evidence.aic_thumbnail_sources(record)) == 1


def test_latest_person_is_not_assigned_to_an_older_record():
    rows = evidence.join_aic_event_data({
        "record_list": [{"record_id": 1, "device_sn": "cam"}],
        "latest_updates": [{"device_sn": "cam", "event": {"record_id": 2, "person_id": 7}}],
        "personBasicInfoList": [{"person_id": 7, "name": "Alice"}],
    })
    assert rows[0]["latest_update"] == {}
    assert evidence.aic_ai_details(rows[0])["recognized_people"] == []


def test_a_reused_path_without_a_capture_time_does_not_prove_same_event():
    record = {"history": {"thumb_path": "/cover"}, "latest_update": {"event": {"thumb_path": "/cover"}}}
    assert len(evidence.aic_thumbnail_sources(record)) == 1


def test_current_app_cloud_snapshot_is_advertised() -> None:
    """Current app snapshot fields must produce a protected thumbnail route."""
    normalized = evidence.normalize_cloud_event(
        {
            "station_sn": "station-private",
            "device_sn": "camera-private",
            "start_time": 1_700_000_000,
            "snapshot_cloud": "https://example.invalid/private.jpg",
        }
    )
    assert normalized["has_thumbnail"] is True
    assert "snapshot_cloud" not in normalized


def test_local_ai_details() -> None:
    """HomeBase crop semantics remain useful without the local disk path."""
    result = evidence.local_ai_details(
        {
            "history": {"trigger_type": 2, "vision": 4},
            "picture": [
                {
                    "detection_type": 3,
                    "person_recog_flag": True,
                    "crop_path": "/private/homebase/path",
                    "crop_pic_quality": 90,
                }
            ],
        }
    )
    assert result["categories"] == ["face", "person"]
    assert result["crops"][0]["quality"] == 90
    assert result["crops"][0]["recognized"] is True
    assert "crop_path" not in result["crops"][0]


def test_homebase_pro_aic_join_and_privacy() -> None:
    """AIC tables join by record/evidence id and keep paths behind protected routes."""
    rows = evidence.join_aic_event_data(
        {
            "record_list": [
                {
                    "record_id": 7,
                    "evidence_id": "ev-7",
                    "device_sn": "camera-private",
                    "station_sn": "station-private",
                    "device_name": "Dock Camera",
                    "start_timestamp": 1_700_000_000,
                    "thumb_path": "/private/thumb.jpg",
                    "snapshot_cloud": "https://example.invalid/private.jpg",
                }
            ],
            "eventRecordList": [{"record_id": 7, "event_name": "person"}],
            "recordPictureList": [
                {"record_id": 7, "detection_type": 2, "crop_path": "/private/crop.jpg"}
            ],
            "evidenceRecordList": [
                {"evidence_id": "ev-7", "evidenceSummarize": "Person at dock"}
            ],
            "latest_updates": [
                {"device_sn": "camera-private", "event_count": 4}
            ],
            "personBasicInfoList": [
                {"person_id": 42, "name": "Alice", "relation": "1"},
                {"person_id": 99, "name": "stranger1", "relation": "0"},
            ],
        }
    )
    assert len(rows) == 1
    assert len(rows[0]["events"]) == 1
    assert len(rows[0]["picture"]) == 1
    assert len(rows[0]["evidence"]) == 1

    normalized = evidence.normalize_aic_event(rows[0])
    ai = evidence.aic_ai_details(rows[0])
    assert normalized["source"] == "homebase_pro_aic"
    assert normalized["has_thumbnail"] is True
    assert normalized["ai_categories"] == ["person"]
    assert normalized["latest_event_count"] == 4
    assert ai["latest_event_count"] == 4
    assert ai["crops"][0]["has_image"] is True
    serialized = repr(ai)
    assert "/private/" not in serialized
    assert "camera-private" not in serialized
    assert "station-private" not in serialized


def test_homebase_person_roster_resolves_names_without_ids() -> None:
    """Known HomeBase people become names while numeric ids remain private."""
    rows = evidence.join_aic_event_data(
        {
            "record_list": [{"record_id": 17, "device_sn": "private", "person_id": 42}],
            "recordPictureList": [{"record_id": 17, "person_id": 42, "person_recog_flag": True}],
            "personBasicInfoList": [
                {"person_id": 42, "name": "Alice", "relation": "1"},
                {"person_id": 99, "name": "stranger1", "relation": "0"},
            ],
        }
    )
    details = evidence.aic_ai_details(rows[0])
    normalized = evidence.normalize_aic_event(rows[0])
    assert details["recognized_people"] == ["Alice"]
    assert normalized["recognized_people"] == ["Alice"]
    assert "person_id" not in repr(details["analysis"])
    assert "42" not in repr(details["analysis"])


def test_homebase_pro_channel_only_and_camel_case_records() -> None:
    """Newer Pro firmware can identify cameras by channel and camel-case fields."""
    rows = evidence.join_aic_event_data(
        {
            "recordList": [
                {
                    "recordId": 9,
                    "deviceChannel": 4,
                    "startTimestamp": 1_700_000_100,
                    "snapshotCloud": "https://example.invalid/private.jpg",
                }
            ],
            "record_picture_list": [
                {"recordId": 9, "detection_type": 2, "cropPath": "/private/crop.jpg"}
            ],
            "latest_updates": [
                {"channel": 4, "eventCount": 3}
            ],
        }
    )
    assert len(rows) == 1
    assert rows[0]["device_sn"] is None
    assert rows[0]["device_channel"] == 4
    assert len(rows[0]["picture"]) == 1
    normalized = evidence.normalize_aic_event(rows[0])
    assert normalized["has_thumbnail"] is True
    assert normalized["latest_event_count"] == 3
    assert normalized["start"].startswith("2023-")


def test_homebase_pro_latest_update_supplies_thumbnail() -> None:
    """The Pro may put the only usable snapshot on latest_update.event."""
    rows = evidence.join_aic_event_data(
        {
            "record_list": [
                {
                    "record_id": 11,
                    "device_channel": 2,
                    "start_timestamp": 1_700_000_200,
                }
            ],
            "latest_updates": [
                {
                    "record_id": 11,
                    "event": {
                        "record_id": 11,
                        "snapshotCloud": "https://example.invalid/latest.jpg",
                    },
                }
            ],
        }
    )
    assert rows[0]["latest_update"]["event"]["snapshotCloud"].endswith("latest.jpg")
    assert evidence.normalize_aic_event(rows[0])["has_thumbnail"] is True


if __name__ == "__main__":
    test_cloud_ai_details()
    test_local_ai_details()
    test_homebase_pro_aic_join_and_privacy()
    test_homebase_pro_channel_only_and_camel_case_records()
    test_homebase_pro_latest_update_supplies_thumbnail()
    print("Evidence privacy and AI detail tests passed")
