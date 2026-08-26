# Changelog

## 9.5.1 — 2026-08-25

- Load camera snapshots automatically in a single-file queue with a two-second gap. Manual
  refreshes share the same one-at-a-time gate, while live streams remain explicit, preventing a
  large camera inventory from saturating P2P.
- Degrade an unavailable account index to the compatible local HomeBase index with a visible
  warning instead of failing the entire evidence query.
- Start and stop the Eufy P2P session around dashboard live view, instead of asking Home
  Assistant to play an idle camera source.
- Migrate the legacy `no_stream_in_hass` option off so native HLS video is available on existing
  Miami and Baiamonte entries.
- Discover large camera inventories through a four-at-a-time bridge queue and abandon a wedged
  inventory after three minutes, preventing Eufy setup from blocking Home Assistant startup.

## 9.5.0 — 2026-08-25

- Add an authenticated Baiamonte Eufy Security application with a responsive DVR-style live
  camera grid and a 1–31 day HomeBase/account evidence timeline.
- Expose complete useful AI analysis in service responses and the Evidence UI: categories,
  recognized/stranger results, confidence and box/tracking fields when supplied, HomeBase crop
  quality and timestamps. Continue excluding account IDs, cipher material and transport paths.
- Add protected thumbnail and saved-recording endpoints. Recordings use Eufy's encrypted P2P
  download command and are remuxed to seekable MP4 inside Home Assistant; media is never copied
  to `/config/www` or made anonymously accessible.
- Correct the companion's camel-case capability checks for S380 local database and thumbnail
  commands, and bound concurrent recording/image downloads and in-memory media caches.

## 9.4.1 — 2026-08-25

- Expose the HomeBase Professional backup battery, LTE signal/band/registration and modem
  firmware as normal read-only diagnostics.
- Add disabled-by-default, values-redacted structure sensors for SIM-slot and eMMC/HDD status,
  plus a response-producing storage refresh action that never formats or mutates a disk.
- Accept both the bridge's historical camel-case and normalized station command capability names,
  and send the exact date format required by local S380 record queries.

## 9.4.0 — 2026-08-25

- Add a response-producing `search_events` service for the authenticated recording index and
  locally indexed S380 recordings, with hybrid deduplication and bounded date/result filters.
- Preserve AI event usefulness as person, face, vehicle, pet, package, sound, crying and motion
  categories while excluding raw storage paths, cipher material, URLs, face/person IDs,
  coordinates and confidence payloads.
- Gate local HomeBase database queries on the exact station commands advertised at runtime, so
  the S380 can use its proven local index while the newer T9000 Professional safely falls back to
  the account index until its distinct local protocol is identified.

## 9.3.4 — 2026-08-25

- Keep `stream_source()` side-effect-free because Home Assistant probes it while adding every
  camera for WebRTC support; explicit Start P2P remains the only live-stream start path.
- Retain on-demand snapshot capture, truthful failed-start errors, neutral empty event images, and
  T8134 control filtering from 9.3.2–9.3.3.

## 9.3.3 — 2026-08-25

- Report a failed P2P or RTSP media handshake as a real Home Assistant service error instead of
  returning success while the camera remains idle.
- Suppress three generic AI detection switches on T8134 that its native Solo Camera command enum
  cannot accept; Human and All Other Motion controls remain available.

## 9.3.2 — 2026-08-25

- Start advertised P2P streams on demand for Home Assistant live-view and snapshot requests,
  capture a fresh frame, and stop short-lived snapshot streams cleanly.
- Return a valid neutral image while no Eufy event image is cached so device-page image requests
  do not fail with HTTP 500; the availability attribute remains authoritative.

## 9.3.1 — 2026-08-25

- Make P2P stream stopping idempotent when the camera is already idle.
- Disambiguate camera and station command buttons on merged device pages and label station
  connectivity as an on-demand P2P session rather than device availability.
- Replace the unknown raw event-image URL sensor with a privacy-safe Available/Waiting status.

## 9.3.0 — 2026-08-25

- Adds a privacy-safe stable device key and property identifier to normal Eufy entities so trusted local dashboards can join related state without serial numbers or editable entity-name assumptions.
- Publishes cached event-image availability independently of its timestamp state, restoring persistent evidence cleanly after restarts.
- Removes the unused malformed device-tracker stub; no configured platform or entity is removed.

## 9.2.1 — 2026-08-25

- Keep readable/writable catalog properties available as disabled-by-default diagnostic sensors
  while their writable controls remain the authoritative configuration entities. This restores
  compatibility with Home Assistant 2026.8, which rejects SensorEntity instances in the config
  category.

## 9.2.0 — 2026-08-25

- Add disabled-by-default diagnostic sensors for complex AI objects. Their states and attributes
  expose only structure, collection sizes, keys, and field types—never recognition results, IDs,
  coordinates, URLs, or writable controls.
- Distinguish effective native read catalogs from Eufy-issued descriptor requests in the bridge
  coverage entity.
- Force complex writable objects into disabled-by-default diagnostic sensors so Home Assistant
  never mistakes their schema visibility for a normal configuration control.

## 9.1.1 — 2026-08-25

- Publish privacy-safe camera capability flags so dashboards can render PTZ,
  preset, calibration, streaming and quick-response controls only where the
  connected model advertises them.
- Keep device identifiers, stream URLs and raw bridge payloads out of the new
  capability contract.

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
