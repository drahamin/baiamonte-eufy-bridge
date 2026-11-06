"""The RTC identity must not turn an untrusted domain into a token destination."""
import ast
from pathlib import Path
from typing import Any
import pytest
import asyncio
import json
from types import SimpleNamespace

PATH = Path(__file__).parents[1] / "eufy-mega-ws/pro-events/pro_event_helper.py"
TREE = ast.parse(PATH.read_text())
NS = {"Any": Any}
exec(compile(ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in {"portal_region", "smart_urls"}], type_ignores=[]), str(PATH), "exec"), NS)


@pytest.mark.parametrize("region", ["us", "eu", "ie"])
def test_only_known_portal_domains_are_used(region):
    assert NS["portal_region"]({"code": 0, "data": {"domain": f"mega-{region}-pr.eufy.com"}}) == region
    websocket, sign = NS["smart_urls"]("T9000TEST", region)
    assert websocket.startswith("wss://security-smart")
    assert ("-ie." in sign) == (region == "ie")


@pytest.mark.parametrize("data", [{}, None, {"code": 0, "data": {"domain": "mega-ie-pr.eufy.com.evil.test"}}, {"code": 401, "data": {"domain": "mega-us-pr.eufy.com"}}])
def test_missing_failed_or_hostile_estimate_is_refused(data):
    with pytest.raises(RuntimeError):
        NS["portal_region"](data)


def test_country_is_not_used_as_rtc_cluster():
    with pytest.raises(ValueError):
        NS["smart_urls"]("T9000TEST", "IT")


def test_discovery_uses_web_identity_without_credentials_or_redirects():
    calls = []
    class Response:
        status = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        @property
        def content(self): return self
        async def iter_chunked(self, size):
            yield b'{"code":0,"data":'
            yield b'{"domain":"mega-ie-pr.eufy.com"}}'
    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def post(self, url, **kwargs):
            calls.append((url, kwargs))
            return Response()
    namespace = dict(NS, json=json, aiohttp=SimpleNamespace(ClientSession=Session, ClientTimeout=lambda **kwargs: kwargs))
    node = next(n for n in TREE.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "discover_portal_region")
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(PATH), "exec"), namespace)
    assert asyncio.run(namespace["discover_portal_region"]("GB")) == "ie"
    url, kwargs = calls[0]
    assert url.startswith("https://mega-eu-pr.eufy.com/")
    assert kwargs["headers"] == {"App-Name": "eufy_mega", "Model-Type": "WEB"}
    assert kwargs["json"] == {"ab": "gb", "mode": 1}
    assert kwargs["allow_redirects"] is False and kwargs["timeout"]["total"] == 5
