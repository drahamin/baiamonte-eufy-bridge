# Baiamonte Eufy Security

Home Assistant companion integration for **Baiamonte eufy Bridge**.

Version 9.3.4 is an in-place successor to `fuatakgun/eufy_security` 8.2.4. It deliberately retains
the `eufy_security` domain and entity unique-ID format, while replacing the visible product name,
documentation, diagnostics, and connection handling.

## Added in the Baiamonte companion

- WebSocket response timeouts instead of indefinitely stuck initialization.
- Safe handling of early device events and non-text WebSocket frames.
- No raw bridge messages, MFA values, captcha values, stream URLs, or config-entry data in logs.
- End-to-end bridge connection entity.
- Mega catalog research-coverage entity with verified, classified, unresolved, unique-ID, official
  catalog, schema, authentication, and compatibility-fallback attributes.
- Disabled-by-default structured AI diagnostic sensors that publish only object/array shape, keys,
  and field types; raw recognition values and writes are deliberately excluded.
- Privacy-safe downloadable Home Assistant diagnostics.
- Automatic version-2 config-entry migration and Baiamonte title adoption without entity churn.
- Input validation for raw JSON and log-level services.
- Background reconnect coalescing so one outage cannot schedule repeated reloads.

The integration expects the bridge WebSocket on port 3000 and its redacted diagnostics endpoint on
port 8097 by default.

## HomeBase evidence

The `eufy_security.search_events` action returns a privacy-safe recording index for dashboard and
automation use. `source: hybrid` combines the authenticated account index with a local HomeBase
database query only when that station advertises the required command. The response contains
times, friendly device/station names, AI categories, favorite/viewed status, and whether a
thumbnail or video exists. It deliberately omits storage paths, cipher keys, transport URLs,
recognition identities, face images and coordinates.

The S380 currently advertises the local database family. HomeBase Professional S1 uses the
account index until its separate local record protocol is directly observed and validated.
