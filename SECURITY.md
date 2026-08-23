# Security notes

- Use a dedicated Eufy account shared to the required devices; do not use your primary owner login
  unless a device feature requires it.
- Credentials are written only to `/data/eufy-security-ws-config.json` with mode `0600` inside the
  add-on data volume.
- `snapshot_cache: true` stores the last event image for each camera in that same private volume.
- Debug logs may include device serials and event metadata. Disable debug after troubleshooting.
- No new cloud credentials, signing keys, or private Eufy material are included by this project;
  the vendored constants are the same public interoperability values present upstream.
