"""The helper must cancel and unwind before the parent hard-kills its process."""
import ast
import asyncio
import io
import json
import signal
from pathlib import Path
from types import SimpleNamespace

PATH = Path(__file__).parents[1] / "eufy-mega-ws/pro-events/pro_event_helper.py"
TREE = ast.parse(PATH.read_text())


def test_total_budget_cancels_operation_and_removes_signal_handler():
    async def exercise():
        released, signals = [], []
        async def operation(_config):
            try:
                await asyncio.Event().wait()
            finally:
                released.append(True)
        async def bounded(coroutine, timeout):
            assert timeout == 50
            return await asyncio.wait_for(coroutine, timeout=0.001)
        loop = SimpleNamespace(add_signal_handler=lambda *args: signals.append("add"), remove_signal_handler=lambda *args: signals.append("remove"))
        namespace = dict(json=json, signal=signal, sys=SimpleNamespace(stdin=io.StringIO("{}")), run=operation,
                         asyncio=SimpleNamespace(current_task=asyncio.current_task, get_running_loop=lambda: loop, wait_for=bounded))
        node = next(n for n in TREE.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "main")
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(PATH), "exec"), namespace)
        try:
            await namespace["main"]()
            raise AssertionError("expected total timeout")
        except asyncio.TimeoutError:
            pass
        assert released == [True] and signals == ["add", "remove"]
    asyncio.run(exercise())
