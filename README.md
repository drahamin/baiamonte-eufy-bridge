# Baiamonte eufy Bridge for Home Assistant

This Baiamonte-owned fork provides a migration-ready Home Assistant add-on for the existing
[`fuatakgun/eufy_security`](https://github.com/fuatakgun/eufy_security) integration. It keeps the
WebSocket schema at **21**, uses `eufy-security-ws` **3.1.0**, and adds focused fixes around the
published eufy Mega v6 transition code.

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
6. Keep the Home Assistant Eufy Security integration pointed at `127.0.0.1:3000`. Reload it after
   the add-on reports that the WebSocket server is listening.

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
| Home Assistant custom integration | `fuatakgun/eufy_security` 8.2.4 |
| WebSocket schema | 21 |
| WebSocket server | `eufy-security-ws` 3.1.0 |
| Client build | `eufy-security-client` 4.1.1-mega.8 (upstream 4.1.1) |
| Home Assistant architectures | amd64, aarch64 |
| Runtime | Node.js 24 on HA base 3.23 |

See [architecture and patch notes](ARCHITECTURE.md), the add-on's
[configuration guide](eufy-mega-ws/DOCS.md), and the provider-by-provider
[migration contract](MIGRATION.md).

## Upstream and license

This project is a compatibility build based on the MIT-licensed work in
[`bropat/eufy-security-client`](https://github.com/bropat/eufy-security-client),
[`bropat/eufy-security-ws`](https://github.com/bropat/eufy-security-ws), and
[`bropat/hassio-eufy-security-ws`](https://github.com/bropat/hassio-eufy-security-ws). It is not
affiliated with Anker or Eufy.
