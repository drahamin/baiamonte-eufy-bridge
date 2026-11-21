# Snapshot reliability repair — 2026-11-21

Bridge 1.6.71, patched client 4.1.1-mega.46, companion 9.6.45.

## Implemented

- Adapt [SDK #471](https://github.com/mega-yfue/eufy-sdk/pull/471): a full unanswered MCS heartbeat interval retires the half-open push socket. Any inbound protocol frame restores liveness, so quiet cameras do not cause false reconnects. Explicit close cancels timers; reconnect replaces its parser callback instead of accumulating duplicate callbacks.
- Adapt [SDK #650](https://github.com/mega-yfue/eufy-sdk/pull/650), [#680](https://github.com/mega-yfue/eufy-sdk/pull/680), [#646](https://github.com/mega-yfue/eufy-sdk/pull/646), and [#654](https://github.com/mega-yfue/eufy-sdk/pull/654): retain incoming header version; version 8 selects authenticated ECIES/P-256 and the full 32-byte session key. RSA uses the full binary ciphertext, PEM or PKCS#8 DER keys, and explicit padding validation. Both branches may progress concurrently; failure of one cannot erase another key, and a retired connection cannot install a late key. Established GCM keys are retained. JSON command frames use the app GCM header; protected DATA/CONTROL image and database replies are authenticated before parsing. Existing RSA/level-1 and negotiated cipher-0 read routes remain separate. Invalid GCM authentication never falls back to parsing ciphertext.
- Adapt the bounded principle of [bridge #193](https://github.com/mega-yfue/ha-eufy-sdk-bridge/pull/193): after three silent read windows, reconnect only a previously responsive station connection. Never reconnect a never-responsive station, a Pro through P2P, an active media station, or a recording transfer. A new connection must answer before another recovery can occur. No whole-app or HA restart loop is introduced.
- Repair stale/undated recovery: the serial-scoped, six-hour-rate-limited search includes invalid, absent, undated, future-dated and day-old snapshots. Reads share a per-station lock; Pro reads already performed in the broad latest pass are not repeated per camera.
- Manual refresh includes the Pro latest-event index, retaining its timeout and serialization bounds. Routine maintenance remains non-live.
- Add a camera snapshot_refresh_needed attribute and flag future timestamps as stale in the panel. Bump the frontend asset version so browsers load the repair. Preserve cached pictures and their original times when retrieval fails; receipt time is never invented as capture time.

- Cache the Python/WebRTC runtime independently of camera source changes so future ARM updates do not recompile it for every client fix. Dependency versions, pinned SCTP assets and startup self-test remain unchanged.

## Verification and limits

Regression tests cover authenticated key unwrap, wrong keys/tags/truncation, both reply layouts, outgoing frame bytes, concurrent and retired key lookups, decrypted DATA database replies, heartbeat silence/acks/shutdown, guarded station recovery and wiring, per-station recovery serialization, stale selection, Pro-pass reuse, cooldown and no live captures. Existing client/server, Python, Node, shell, build and CI gates must pass before rollout.

This does not supply missing vault keys, promise new firmware capabilities, enable automatic live viewing, or establish hardware success before host testing. The Pro full-frame recording image route remains an open upstream limitation ([#558](https://github.com/mega-yfue/eufy-sdk/issues/558)); [v8 image decoding #455](https://github.com/mega-yfue/eufy-sdk/pull/455) remains unfinished. A key negotiation repair is not proof of a camera streaming or an image becoming current.
