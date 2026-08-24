# Configuration

This release operates in explicit hybrid mode: Mega v6 owns authentication and push registration,
legacy cloud owns inventory and cloud properties that have no published Mega replacement, and P2P
owns streams/direct device communication. The active boundary is printed in the startup log.

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
- `No houses/stations/devices found`: the account no longer has legacy inventory access. The public
  v6 bridge cannot restore unpublished inventory endpoints.
- `Baiamonte cloud policy: hybrid ...`: informational capability ownership; use it to verify that a
  future release has moved specific features to Mega rather than silently falling back.
- Push connects but no event arrives: confirm the dedicated account receives that camera's
  notifications in Eufy's app and try `ipv4first: true` if FCM connection errors appear.
- Snapshot retries exhaust: enable debug temporarily, trigger a fresh event, and verify the push
  includes `pic_url`. Expired historical S3 URLs cannot be repaired.
