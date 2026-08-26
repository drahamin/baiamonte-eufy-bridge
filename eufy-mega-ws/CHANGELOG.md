# Changelog

## 1.6.10 — 2026-08-26

- Keep the ingress dashboard alive when a HomeBase Pro AIC evidence query times out or its WebSocket
  session closes, and return an identifier-free unavailable result instead of leaking an unhandled
  event-wait rejection.

## 1.6.9 — 2026-08-26

- Add a bounded, read-only HomeBase Professional AIC diagnostic action to the
  bridge dashboard API. It reports collection counts, field names/types, and
  serial/channel/media coverage only; record values, identifiers, paths, URLs,
  recognition data, and live video are excluded.

## 1.6.8 — 2026-08-26

- Correlate HomeBase Professional AIC events by camera serial or station channel,
  matching current firmware that omits a serial from some E42/T8173, dock-camera,
  and doorbell history rows.
- Accept current snake-case and camel-case AIC device, timestamp, thumbnail, cloud,
  crop, and recording fields. Channel resolution is exposed read-only to Security;
  it does not authorize controls or start live video.

## 1.6.7 — 2026-08-26

- Reproduce the current iPhone app's HomeBase Professional `AICEventData` database
  query, including its descending cursor payload and joined history, crop-picture,
  event, and evidence collections.
- Feed Pro `latest_updates`, `thumb_path`, and `snapshot_cloud` into the serialized
  snapshot cache and expose joined AI evidence through Baiamonte Security's protected
  evidence routes. Daily refresh remains non-live and queries only the cloud index plus
  AIC-capable stations; legacy S380 history remains an explicit serialized action.
- Audit current iPhone S380 and camera paths. Existing S380 storage, cross-camera
  tracking, tracking assistance, camera PTZ/presets, motion tracking, auto-cruise, and
  NAS controls remain covered. Newly observed camera snapshot-interval command 6453 is
  identified as research-only until its two payload keys are safely verified.

## 1.6.6 — 2026-08-26

- Enable the HomeBase Professional S1 read-only latest-record query identified in
  the current iPhone app as `GET_LATEST_RECORD_INFO`.
- Allow the Pro to return its selected thumbnail through the existing serialized
  HomeBase image downloader. Destructive database, reboot, and alarm commands stay disabled.

## 1.6.5 — 2026-08-26

- Follow the current eufy iPhone app's dashboard image model by reading its
  `v3/app/get_devs_list` cover metadata alongside the mature device inventory.
- Rank `local_cover`, remote `cover`, cached `image`, and device-thumbnail sources
  by their app timestamps, preferring the HomeBase copy when timestamps tie.
- Merge image metadata only: controls, P2P credentials, and device capabilities
  continue to come from the proven inventory, and snapshot retrieval stays serialized.

## 1.6.4 — 2026-08-26

- Normalize both legacy S380 and newer HomeBase Professional latest-event database
  envelopes, including nested/string payloads and current local/cloud thumbnail names.
- Feed each validated latest-event cover into the camera picture property and the
  persistent cache. Retrieval remains one image at a time and never opens livestreams.
- Ignore empty and video-only database records instead of treating them as snapshots,
  and log only aggregate cover counts for diagnostics.

## 1.6.3 — 2026-08-26

- Populate initial non-URL `cover_path` values through the owning HomeBase; the
  prior handler saw only later property changes and missed the official app's
  already-present startup cards.
- Delay cover retrieval ten seconds for station readiness and issue strictly one
  image request every 1.25 seconds. This path uses HomeBase thumbnail download,
  never livestream or FFmpeg.

## 1.6.2 — 2026-08-26

- Download authenticated `cover_path` dashboard thumbnails used by the official
  Eufy Security home screen and publish them as canonical camera pictures instead
  of ignoring valid cloud picture URLs.
- Bound dashboard-thumbnail startup work to two downloads at a time with a short
  inter-request gap, validate image type and size, and feed successful results
  into the existing persistent snapshot cache without exposing source URLs.

## 1.6.1 — 2026-08-25

- Hydrate HomeBase Professional modem firmware and privacy-sanitized SIM-slot status from the
  already observed native Mega parameter envelopes. Card/subscriber identifiers and APN/PIN
  material are discarded before the WebSocket model is built.
- Add Professional eMMC/HDD metadata support and correct station-command capability recognition
  in the evidence dashboard, including S380 local indexes and thumbnail transport.

## 1.6.0 — 2026-08-25

- Add explicit HomeBase evidence/video capability reporting to the ingress dashboard: account
  index authentication, local/date indexes, direct thumbnail retrieval, encrypted saved-clip
  transport, and live-view coverage.
- Keep the bridge dashboard privacy-safe and place actual video playback behind authenticated
  Home Assistant access; no record path, cipher, identity result or media URL is published by the
  diagnostics endpoint.

## 1.5.6 — 2026-08-25

- Remove the temporary one-shot Dock audit trigger and option after live validation, leaving the
  production dashboard and launcher free of test-only control paths.
- Retain idempotent livestream-stop handling for safe independent bridge and companion restarts.

## 1.5.5 — 2026-08-25

- Read the explicitly configured audit target directly in the launcher so optional-value
  normalization cannot suppress a valid device name.

## 1.5.4 — 2026-08-25

- Pass the explicit one-shot audit target from the Supervisor-aware launcher into the isolated
  dashboard process without exposing account settings or opening a network control endpoint.

## 1.5.3 — 2026-08-25

- Allow an explicitly configured one-shot control audit to run through Home Assistant app options
  when shared-folder namespaces are isolated, and emit only its privacy-safe result summary.

## 1.5.2 — 2026-08-25

- Retry a pending, explicit local control audit after bridge startup so a slow camera inventory
  cannot prevent the requested one-shot validation from running.

## 1.5.1 — 2026-08-25

- Make duplicate livestream-stop requests idempotent so device-page cleanup no longer produces
  false errors after a stream has already ended.
- Add an explicit, one-shot local device control audit for validating advertised writable
  properties and reversible camera commands without recording device values or identifiers.

## 1.5.0 — 2026-08-25

- Adds a privacy-safe stable device relationship key to camera, image, sensor, binary-sensor and control entities so downstream applications no longer depend on editable Home Assistant entity IDs.
- Marks whether a persistent Eufy event image is actually present, allowing cached push evidence to return after an integration or Home Assistant restart even when the image timestamp state is initially unknown.
- Removes the unused malformed device-tracker platform stub; the integration continues to expose only platforms with implemented entity semantics.

## 1.4.1 — 2026-08-25

- Redact Firebase installation identifiers and credential fields from push registration logs.

## 1.4.0 — 2026-08-25

- Query both the native `device_new_pn` product code and model alias when they differ, stopping as
  soon as Eufy returns a populated descriptor catalog.
- Report complete effective native read catalogs separately from Eufy-issued writable-mode
  descriptors, so an empty descriptor response no longer looks like missing inventory coverage.
- Add privacy-safe structured AI schema diagnostics containing only field names, collection sizes,
  and value types; recognition results and configuration values remain private.
- Retain P2P and compatibility inventory/property/command services only where Mega has not yet
  supplied a proven complete entity or writable descriptor.
- Exclude local dependencies, build products, coverage reports, and Python caches from the Docker
  build context, reducing it from hundreds of megabytes to about four.

## 1.3.1 — 2026-08-25

- Remove WebSocket peer addresses, ports, and client-supplied close reasons from server logs.

## 1.3.0 — 2026-08-25

- Bind the unauthenticated WebSocket command transport to loopback so it is available to Home
  Assistant and the dashboard but not exposed to arbitrary LAN clients.
- Update vulnerable production dependency chains for `ip-address` and `protobufjs`; both vendored
  packages now pass a zero-production-advisory audit.
- Repair the WebSocket package's TypeScript Jest configuration and restore all 221 server tests.
- Avoid a P2P energy-saving disconnect race when the remote endpoint disappears first, and
  downgrade harmless standalone-station device lookup noise.
- Publish privacy-safe AI property names in dashboard status for companion coverage auditing.
- Redact identifiers, network addresses, URLs, credentials, keys, payloads, and image buffers at
  the client logging boundary before they can reach add-on logs or WebSocket log subscribers.

## 1.2.6 — 2026-08-25

- Replace the ambiguous cloud-migration dump with explicit semantic and research coverage metrics,
  model-scoped catalog totals, unique-ID totals, and plain-language empty-catalog context.
- Promote structured device power-source mode to a verified read-only schema.
- Classify recurring camera, station, device-telemetry, HomeBase Pro, and wired-floodlight ID blocks
  by feature family while keeping their exact semantics unresolved and non-writable.

## 1.2.5 — 2026-08-25

- Correct the aggregate catalog counters so family-classified fields are reported separately and
  no longer inflate the genuinely unresolved total.

## 1.2.4 — 2026-08-25

- Name four directly evidenced HomeBase Pro Mega fields: LTE diagnostics, cellular modem firmware,
  and privacy-safe status envelopes for SIM slots 1 and 2. All remain read-only.
- Separate verified, family-classified, and unresolved observed IDs so recurring platform-reserved
  blocks are no longer presented as missing camera features or mistaken for writable controls.
- Add identifier-free value-shape profiling (empty, integer, version, JSON, or Base64 JSON) to make
  future schema correlation useful without publishing parameter values, SIM identifiers, or device
  identifiers.
- Update the ingress dashboard with expandable classified names, safe value shapes, and honest
  unresolved counts per model.

## 1.2.3 — 2026-08-25

- Resolve schema-21 device and station identifiers into live product records before building the
  dashboard, restoring accurate per-model totals and capabilities.
- Audit every connected camera's advertised commands and writable metadata, and show verified PTZ,
  presets, calibration, tracking, privacy-position, zoom, and writable AI controls in the UI.
- Correct dual-role products such as `T8423` to display as camera and station endpoints.
- Document the reversible Home Assistant Eufy Security 8.2.4 WebSocket recovery patch used for the
  Home Assistant 2026.8 initialization timeout.

## 1.2.2 — 2026-08-25

- Publish redacted per-model known and unknown native data-point ID lists without exposing values,
  serials, account data, broker details, or command credentials.
- Classify each dashboard schema row as a camera, HomeBase/station, smart display, or other device,
  and make its exact unmapped ID list expandable for ongoing schema research.

## 1.2.1 — 2026-08-25

- Add per-model observed Mega schema coverage to the ingress dashboard, including mapped and
  unmapped data-point counts, coverage bars, and explicit read-only access labels.
- Display an operator warning whenever observed catalogs replace empty server catalogs, making the
  command-safety boundary visible in the UI.
- Retitle the remaining legacy inventory path as compatibility coverage while continuing to report
  honestly when it is still active for controls not yet supplied by Mega.

## 1.2.0 — 2026-08-25

- Replace empty server catalogs with per-product observed catalogs synthesized from native house
  inventory; known IDs receive enum names and unknown IDs receive stable `param_<id>` labels.
- Force every synthesized point read-only and retain the distinction between server catalogs and
  observed schemas so inferred inventory can never authorize a command.
- Report observed product/data-point totals and per-model known/unknown coverage in Mega status and
  on the Baiamonte dashboard.

## 1.1.1 — 2026-08-25

- Compare every native Mega inventory parameter ID with the existing legacy enum catalogs and show
  mapped/unmapped coverage on the Baiamonte dashboard without exposing parameter values.

## 1.1.0 — 2026-08-25

- Match the current official Android app identity (`6.0.80_28612`) for Mega requests.
- Decode device descriptors and product data-point catalogs through the nested response envelopes
  used by current Mega modules, while retaining bounded, exact-key parsing.
- Add typed schemas for product catalogs, device relations, named device parameters, consent
  switches, and the native MQTT command envelope; no command is published by discovery.

## 1.0.2 — 2026-08-25

- Permit the Node runtime to read the ingress dashboard and write only the dedicated opt-in E10
  research directory under `/share` in the AppArmor profile.

## 1.0.1 — 2026-08-25

- Move the ingress dashboard to port 8097 to avoid a host-network collision found during the
  parallel Baiamonte/Miami rollout.

## 1.0.0 — 2026-08-25

- Establish the dedicated **Baiamonte eufy Bridge** product identity, add-on slug, repository URL,
  container labels, AppArmor profile, and Home Assistant panel title.
- Add an authenticated Home Assistant ingress dashboard with live device/station totals, per-model
  snapshot, livestream, AI metadata, writable-property, Mega-catalog, OTA, and migration status.
- Correct the decompiled OTA request schema to use `<model>_ota` and `eufy_home`, add the official
  single-device ROM query, and optionally download and verify an offered E10 package without
  invoking an upgrade.
- Preserve Mega authentication/push and P2P control while clearly reporting the legacy fallback
  that remains required until Eufy publishes non-empty product catalogs.

## 3.1.0-baiamonte.9 — 2026-08-25

- Recognize the connected HomeBase Professional S1 (`T9000`) as a station and expose verified
  guard, notification, alarm, time, volume, tracking, backup-battery, and redacted LTE properties.
- Keep unverified Pro reboot/alarm/database commands disabled while retaining verified writable
  parameter controls.
- Query richer Mega per-device capability descriptors and batch OTA metadata in bounded, read-only
  background discovery; identifiers, descriptor contents, versions, and download locations stay out
  of logs.
- Add official-app-derived API coverage for `get_devices_info` and `get_rom_versions` so E10 and
  HomeBase Pro firmware/capability research no longer depends on legacy inventory alone.

## 3.1.0-baiamonte.8 — 2026-08-25

- Include the native inventory `connected` diagnostic and its metadata in schema-21 WebSocket
  serialization so Home Assistant can create the E10 presence entity.

## 3.1.0-baiamonte.7 — 2026-08-25

- Allow read-only WebSocket property, metadata, and command-list queries for standalone native
  devices without resolving a P2P station; mutating and streaming commands still require one.

## 3.1.0-baiamonte.6 — 2026-08-25

- Encode the native inventory presence diagnostic in the client library's expected raw boolean
  format so Home Assistant receives a valid `connected` binary sensor.

## 3.1.0-baiamonte.5 — 2026-08-25

- Add a read-only `Present in Mega inventory` diagnostic for native-only devices so Home Assistant
  creates an E10 device-registry entry without advertising an unverified control.

## 3.1.0-baiamonte.4 — 2026-08-25

- Add the native-only Smart Display E10 (`T87A0`) to schema-21 inventory as a safe read-only
  generic device, using a non-camera internal type and no guessed properties or commands.
- Preserve native-only devices across periodic legacy inventory refreshes without replacing richer
  legacy records for devices visible on both backends.
- Read and cache the official product data-point catalog for every distinct native account model in
  a bounded background scan, combining house inventory with the official Mega device-relation
  inventory (`attribute: 7`); failures and empty catalogs do not affect startup or existing control.
- Redact product codes, identifiers, parameter values, broker data, and account data from catalog
  scan diagnostics.

## 3.1.0-baiamonte.3 — 2026-08-25

- Replace the legacy-shaped native inventory probe with the official Mega
  `house_id` / `categories` / `add_pns` request schema.
- Add a one-shot, identifier-free native inventory diagnostic while legacy inventory remains the
  production provider.
- Add redacted model/category/parameter aggregates and the official product data-point catalog
  request for command-schema research.
- Keep schema-21 entities and all device control on the proven legacy/P2P paths.

## 3.1.0-baiamonte.2 — 2026-08-24

- Ignore null picture values during initial device hydration instead of trying
  to cache them as snapshots.
- Skip RTSP URL synchronization for devices that do not expose the
  `rtspStreamUrl` property.

## 3.1.0-baiamonte.1 — 2026-08-24

- Give the fork a distinct Baiamonte add-on identity and slug.
- Add a machine-readable Mega/legacy/P2P capability map and startup policy log.
- Add a migration contract for replacing legacy capabilities one at a time.
- Add CI enforcement keeping the legacy cloud domain inside the legacy HTTP adapter.
- Validate and default malformed/empty numeric, boolean, and station-list options before generating
  runtime JSON, preventing the observed `jq --argjson` startup crash.

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
