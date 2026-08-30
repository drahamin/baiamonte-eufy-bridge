"""Regression checks for the lightweight scheduled Eufy coordinator update."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_scheduled_update_does_not_request_full_account_inventory():
    source = (ROOT / "custom_components/eufy_security/coordinator.py").read_text()
    method = source.split("async def _update_local(self):", 1)[1].split(
        "async def disconnect(self):", 1
    )[0]

    assert "await self._refresh_bridge_status()" in method
    assert "await self._api.poll_refresh()" not in method


def test_product_actions_can_still_request_an_explicit_refresh():
    source = (
        ROOT / "custom_components/eufy_security/eufy_security_api/product.py"
    ).read_text()

    assert "await self.api.poll_refresh()" in source
