# Changelog

## 9.0.1 — 2026-08-25

- Import stream timing constants from their defining module instead of relying on an upstream
  implicit re-export, restoring camera platform initialization under Home Assistant 2026.8.

## 9.0.0 — 2026-08-25

- Rebrand the Home Assistant integration as **Baiamonte Eufy Security** while retaining the
  `eufy_security` domain and all established entity unique IDs.
- Adopt existing version-1 config entries in place and retitle them without registry churn.
- Incorporate the Baiamonte WebSocket initialization recovery and bounded command-response waits.
- Prevent repeated reconnect reloads and cleanly cancel pending bridge requests on unload.
- Remove raw payload, stream URL, config-entry, captcha, and MFA logging paths.
- Add bridge connectivity and Mega catalog research-coverage diagnostic entities.
- Add privacy-safe Home Assistant diagnostics and validated bridge-level services.
- Remove two unused third-party Python requirements and repair upstream undefined references.
