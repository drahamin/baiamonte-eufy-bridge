# Baiamonte eufy Bridge for Home Assistant

This Baiamonte-owned project now ships both halves of the Home Assistant stack:

- **Baiamonte eufy Bridge**, the add-on that authenticates, discovers, streams, and controls eufy
  products through the schema-21 WebSocket contract.
- **Baiamonte Eufy Security**, the companion custom integration that creates Home Assistant
  entities and services from that bridge.

The companion retains the internal `eufy_security` domain and existing unique IDs so upgrading from
the former `fuatakgun/eufy_security` package does not rename entities or break automations.

## What works

- Existing Home Assistant entities, services, P2P/RTSP streaming, locks, alarms, stations, and
  device controls remain on the established WebSocket contract.
- eufy Mega v6 login, 2FA/captcha flow, encrypted/signed requests, and FCM push-token registration.
- Automatic one-time re-key/retry when Mega rejects a cached ECDH identity with code `4404` or
  `4416`.
- Event snapshots downloaded directly from push-notification `pic_url` values.
- `v2_eufysecurity:` thumbnail reconstruction already present in client 4.1.1.
- Three bounded image attempts with 1- and 3-second waits for the common S3 upload race.
- Optional persistence of each camera's last valid JPEG/PNG/WebP event image in the add-on's private
  `/data/snapshots` directory. Enabled by default.

## Important backend boundary

This is a **hybrid v6 bridge**, not the unreleased native eufy Mega library. The public upstream code
only exposes Mega v6 for authentication and push registration. Inventory/discovery and most commands
still use the legacy Eufy Security HTTP API, while device communication continues over P2P.

That preserves the largest currently usable feature set. If Eufy removes legacy inventory access for
your account and the logs show `No houses/stations/devices found`, this bridge cannot invent the
unpublished v6 endpoint schemas. The upstream maintainers are developing a separate native Mega
library for that eventual replacement.

## Install

1. Stop the official `eufy-security-ws` add-on; both use port `3000` by default.
2. In **Settings → Apps → App store → ⋮ → Repositories**, add:

   `https://github.com/drahamin/baiamonte-eufy-bridge`

3. Install **Baiamonte eufy Bridge**.
4. Enter the same Eufy account, password, country, and station-IP overrides you use now.
5. Start the add-on and complete any requested Mega and legacy email verification steps.
6. Add this same repository to HACS as an **Integration** custom repository and install
   **Baiamonte Eufy Security**. If Eufy Security 8.2.4 is already installed, this is an in-place,
   reversible code upgrade; the existing config entry and entity IDs are adopted automatically.
7. Restart Home Assistant after HACS finishes copying the integration. Keep the bridge endpoint at
   `127.0.0.1:3000` and the diagnostics endpoint at `8097`. The control socket
   is deliberately loopback-only so unauthenticated commands are not exposed to
   other devices on the LAN.

Expected startup messages include:

```text
v6 login: success, mega session persisted
v6 push: FCM token registered on the eufy_mega backend
Push notification connection successfully established
```

Trigger motion or ring a doorbell and verify that the matching
`image.<camera>_event_image` entity updates.

## Compatibility

| Component | Version/contract |
| --- | --- |
| Home Assistant custom integration | Baiamonte Eufy Security 9.3.1 |
| WebSocket schema | 21 |
| WebSocket server | `eufy-security-ws` 3.1.0 |
| Client build | `eufy-security-client` 4.1.1-mega.13 (upstream 4.1.1) |
| Home Assistant architectures | amd64, aarch64 |
| Runtime | Node.js 24 on HA base 3.23 |

See [architecture and patch notes](ARCHITECTURE.md), the add-on's
[configuration guide](eufy-mega-ws/DOCS.md), and the provider-by-provider
[migration contract](MIGRATION.md). The original 8.2.4 WebSocket recovery is now incorporated into
the companion integration; its standalone patch remains documented in
[home-assistant-patches](home-assistant-patches/README.md) for audit history.

## Upstream and license

This project is a compatibility build based on the MIT-licensed work in
[`fuatakgun/eufy_security`](https://github.com/fuatakgun/eufy_security),
[`bropat/eufy-security-client`](https://github.com/bropat/eufy-security-client),
[`bropat/eufy-security-ws`](https://github.com/bropat/eufy-security-ws), and
[`bropat/hassio-eufy-security-ws`](https://github.com/bropat/hassio-eufy-security-ws). It is not
affiliated with Anker or Eufy.
