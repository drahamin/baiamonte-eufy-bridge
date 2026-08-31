"""Regression checks for bounded Eufy reconnect inventory traffic."""

from __future__ import annotations

import ast
from pathlib import Path


SOURCE = Path(__file__).parents[1] / (
    "custom_components/eufy_security/eufy_security_api/api_client.py"
)


def test_product_builder_does_not_multiply_bridge_concurrency() -> None:
    """Per-product reads stay sequential inside the two-product limit."""
    tree = ast.parse(SOURCE.read_text())
    builder = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "_build_product"
    )
    gathers = [
        node
        for node in ast.walk(builder)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "asyncio"
        and node.func.attr == "gather"
    ]
    assert gathers == []

    source = SOURCE.read_text()
    assert "asyncio.Semaphore(2)" in source
    assert "asyncio.timeout(20)" in source
