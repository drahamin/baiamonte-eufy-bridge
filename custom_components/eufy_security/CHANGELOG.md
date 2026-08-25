# Changelog

## 9.1.0 — 2026-08-25

- Expose every writable AI, notification, tracking, lighting, delivery-guard, and PTZ-related
  property currently advertised by the connected Baiamonte and Miami device inventories.
- Add native Home Assistant text controls for writable schedule strings.
- Reject PTZ, preset, and calibration service calls when the target camera does not advertise the
  required command, instead of sending a doomed request.
- Mark camera entities unavailable when the bridge disconnects and fail in-flight requests
  immediately so independent bridge restarts recover without a 30-second timeout backlog.
- Replace raw debug property values with disabled-by-default, privacy-safe property-name and
  command capability summaries.

## 9.0.3 — 2026-08-25

- Declare the integration as config-entry-only for current Home Assistant configuration-schema
  validation.

## 9.0.2 — 2026-08-25

- Treat normal WebSocket close frames as shutdown instead of transport failures.
- Remove device events, property dictionaries, serial numbers, stream URLs, raw bridge commands,
  relay response bodies, and image data from exception and debug-log paths.

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
