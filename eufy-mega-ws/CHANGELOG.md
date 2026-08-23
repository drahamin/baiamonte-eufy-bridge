# Changelog

## 3.1.0-mega.1 — 2026-08-22

- Built the unmodified `eufy-security-ws` 3.1.0 tag with WebSocket schema 21.
- Vendored upstream `eufy-security-client` 4.1.1 as the identifiable local build
  `4.1.1-mega.1`.
- Added one-time Mega ECDH identity recovery for response codes 4404 and 4416.
- Persisted refreshed Mega identity data after successful FCM registration.
- Added bounded push-thumbnail retries for S3 visibility races.
- Added optional persistent last-event snapshot cache, enabled by default in this add-on.
- Redacted signed query parameters from final image-fetch errors.
- Updated packaging for Home Assistant's post-2026.04 local app build format.
