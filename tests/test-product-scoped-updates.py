from pathlib import Path


def test_product_events_do_not_refresh_the_entire_estate() -> None:
    entity = Path("custom_components/eufy_security/entity.py").read_text()
    product = Path(
        "custom_components/eufy_security/eufy_security_api/product.py"
    ).read_text()

    assert "class EufySecurityEntity(Entity)" in entity
    assert "add_state_update_listener(self._handle_product_update)" in entity
    assert "remove_state_update_listener(self._handle_product_update)" in entity
    assert "self.state_update_listeners: set[Callable]" in product
    assert "def notify_state_update" in product
    assert "self.notify_state_update()" in product


def test_camera_tokens_follow_product_scoped_updates() -> None:
    camera = Path("custom_components/eufy_security/camera.py").read_text()

    assert "def _handle_product_update" in camera
    assert "super()._handle_product_update()" in camera
    assert "self.product.notify_state_update()" in camera
