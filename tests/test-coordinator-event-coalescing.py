from pathlib import Path


def test_estate_entity_updates_are_coalesced() -> None:
    source = Path("custom_components/eufy_security/coordinator.py").read_text()

    assert "self._listener_flush_handle" in source
    assert "call_later(\n                1.0, self._flush_entity_updates" in source
    assert "def _flush_entity_updates" in source
    assert "self._listener_flush_handle.cancel()" in source
