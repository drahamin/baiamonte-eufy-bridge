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
    assert "face_url" not in result["analysis"]
    assert result["faces"] == [
        {"position": 1, "recognition": "stranger", "has_image": True}
    ]


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


if __name__ == "__main__":
    test_cloud_ai_details()
    test_local_ai_details()
    print("Evidence privacy and AI detail tests passed")
