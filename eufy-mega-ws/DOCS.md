# Configuration

This release operates in explicit hybrid mode: Mega v6 owns authentication and push registration,
Mega v6 also augments explicitly supported native-only products and reads product data-point
catalogs, legacy cloud owns the main inventory and cloud properties that have no published Mega
replacement, and P2P owns streams/direct device communication. The active boundary is printed in
the startup log.

| Option | Description |
| --- | --- |
| `username` | Dedicated Eufy account email. Required. |
| `password` | Eufy account password. Required. |
| `country` | Two-letter Eufy account region; `US` is the default. |
| `port` | Host-network WebSocket port. Default `3000`. |
| `polling_interval` | Legacy cloud refresh interval in minutes. Default `10`. |
| `event_duration` | Seconds before momentary motion/ring/person sensors reset. Default `10`. |
| `accept_invitations` | Automatically accept shared-device invitations. |
| `snapshot_cache` | Persist and restore the last valid push-event image per camera. Default `true`. |
| `debug` | Enable verbose server/client logs. Do not leave enabled unless diagnosing. |
| `ipv4first` | Prefer IPv4 for Google FCM endpoints when IPv6 routing is broken. |
| `trusted_device_name` | Optional label shown in Eufy's trusted-device list. |
| `stations` | Optional station serial/IP pairs to speed local P2P discovery. |

The Smart Display E10 (`T87A0`) is exposed as a generic read-only device. Its official product
catalog is currently empty, so this release intentionally advertises no E10 controls. A disabled-by-
default `Present in Mega inventory` diagnostic is provided so Home Assistant can register the device.

## Mega schema coverage

The dashboard distinguishes three evidence levels:

- **Verified**: an existing parser or an unambiguous typed payload supports the name.
- **Classified**: the field belongs to a recurring feature family, but its exact semantics remain
  unpublished. These fields are read-only and never authorize a command.
- **Unresolved**: no defensible name or family is known yet.

HomeBase Pro LTE diagnostics, cellular modem firmware, and both SIM-slot status envelopes are named
but remain read-only. SIM envelopes are shape-profiled only; card and subscriber identifiers are
never included in status output. The recurring `1418–1420`, `1509–1513`, and `92xx` blocks occur on
multiple product categories, so the bridge labels them as cross-product or Mega capability fields
instead of inventing camera-specific AI names.

## Suggested configuration

```yaml
username: your-dedicated-eufy-account@example.com
password: your-password
country: US
port: 3000
polling_interval: 10
accept_invitations: true
debug: false
ipv4first: false
event_duration: 10
snapshot_cache: true
stations:
  - serial_number: T8030XXXXXXXXXXX
    ip_address: 192.168.1.123
```

## First start and 2FA

The transitional client authenticates Mega v6 first and legacy second. Either backend can request
its own email verification code or captcha. Complete the prompt from the Home Assistant Eufy
Security integration, then allow up to 30 seconds for discovery.

## Home Assistant integration

Use `fuatakgun/eufy_security` 8.2.4 and connect it to:

- Host: `127.0.0.1`
- Port: the configured add-on port (`3000` by default)

The server continues to advertise WebSocket schema 21.

## Snapshot behavior

On a matching push event the client downloads `pic_url`, reconstructs the newer
`v2_eufysecurity:` format when present, and updates the device's `picture` property. A 404/empty
response gets two more attempts after waits of 1 and 3 seconds before the existing P2P image
fallback is scheduled.

With `snapshot_cache: true`, the last valid image is kept inside the add-on's private data volume so
the HA image entity does not start empty after an add-on restart. Disable this option if you do not
want event images stored on disk.

## Troubleshooting

- `4404 get identity error` once, followed by a retry and successful registration: expected recovery.
- Repeated `4404` after the single retry: the session/region is being rejected; restart once and
  complete a new Mega login prompt if offered.
- `No houses/stations/devices found`: the account no longer has legacy inventory access. Native
  augmentation can expose explicitly supported native-only models, but cannot yet replace the full
  unpublished property/command layer.
- `Baiamonte cloud policy: hybrid ...`: informational capability ownership; use it to verify that a
  future release has moved specific features to Mega rather than silently falling back.
- Push connects but no event arrives: confirm the dedicated account receives that camera's
  notifications in Eufy's app and try `ipv4first: true` if FCM connection errors appear.
- Snapshot retries exhaust: enable debug temporarily, trigger a fresh event, and verify the push
  includes `pic_url`. Expired historical S3 URLs cannot be repaired.
