"""Use a Pro's embedded image before opening any image download connection."""
import ast
import asyncio
import base64
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

ROOT = Path(__file__).parents[1]
TREE = ast.parse((ROOT / "custom_components/eufy_security/coordinator.py").read_text())
NODE = next(n for n in ast.walk(TREE) if isinstance(n, ast.AsyncFunctionDef) and n.name == "evidence_thumbnail")


def test_embedded_pro_thumbnail_is_returned_without_p2p_or_cloud_request():
    pixels = b"\xff\xd8\xff" + b"p" * 2000
    row = {"history": {"record_id": 7, "thumb_data": "embedded"}}
    namespace = {"aic_thumbnail_sources": lambda record: [record["history"]], "decode_inline_snapshot": lambda value: pixels if value == "embedded" else b""}
    exec(compile(ast.Module(body=[NODE], type_ignores=[]), "coordinator.py", "exec"), namespace)
    coordinator = SimpleNamespace(_evidence=lambda event: ("aic", row),
                                  _buffer_bytes=lambda value: pixels if value == "embedded" else b"",
                                  _record_field=lambda *args: None,
                                  _valid_snapshot=lambda value: value == pixels,
                                  _download_trusted_eufy_image=AsyncMock(side_effect=AssertionError("must not fetch")))
    result = asyncio.run(namespace["evidence_thumbnail"](coordinator, "event"))
    assert result == (pixels, "image/jpeg")
    coordinator._download_trusted_eufy_image.assert_not_awaited()


def test_inline_decoder_handles_firmware_whitespace_and_refuses_other_payloads():
    path = ROOT / "custom_components/eufy_security/snapshot.py"
    spec = importlib.util.spec_from_file_location("inline_snapshot", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    pixels = b"\xff\xd8\xff" + b"p" * 2000
    encoded = base64.urlsafe_b64encode(pixels).decode().rstrip("=")
    assert module.decode_inline_snapshot("data:image/jpeg;base64,\n" + encoded[:80] + "\r\n" + encoded[80:]) == pixels
    assert module.decode_inline_snapshot("data:text/html;base64," + encoded) == b""
    assert module.decode_inline_snapshot("not an image") == b""
    assert module.decode_inline_snapshot("x" * (module.MAX_SNAPSHOT_BYTES * 2)) == b""
