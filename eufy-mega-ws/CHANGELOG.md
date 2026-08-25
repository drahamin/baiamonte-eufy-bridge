# Changelog

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
