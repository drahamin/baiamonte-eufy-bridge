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


def test_pro_hangup_before_command_channel_fails_without_waiting_for_deadline():
    async def exercise():
        nodes = [node for node in ast.walk(TREE) if isinstance(node, ast.AsyncFunctionDef) and node.name == "receive_signals"]
        node = nodes[0]
        # The receiver uses enclosing run state in production. Recreate that
        # scope without importing hardware/crypto dependencies into these tests.
        wrapper = ast.parse("async def exercise_receiver():\n answered = False\n heartbeat = None\n").body[0]
        wrapper.body.extend([node, ast.parse("await receive_signals()").body[0]])
        ast.fix_missing_locations(wrapper)
        class Socket:
            def __aiter__(self): return self
            async def __anext__(self):
                if getattr(self, "sent", False): raise StopAsyncIteration
                self.sent = True
                return "synthetic-hangup"
        collector = SimpleNamespace(error=None, done=asyncio.Event())
        namespace = dict(websocket=Socket(), parse_signal=lambda raw: ({"action": 3, "dataType": "hangup"}, None),
                         command_open=False, collector=collector, log=lambda text: None)
        exec(compile(ast.Module(body=[wrapper], type_ignores=[]), str(PATH), "exec"), namespace)
        await namespace["exercise_receiver"]()
        assert collector.done.is_set()
        assert str(collector.error) == "HomeBase Pro ended the call before its command channel opened"
    asyncio.run(exercise())
