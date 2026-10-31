# Eufy successor SDK audit — 2026-10-31

## Upstream position

The former `bropat/eufy-security-client` and `eufy-security-ws` projects were archived on
2026-09-12. Active protocol work moved to:

- `mega-yfue/eufy-sdk` (current stable reviewed: 0.5.0)
- `mega-yfue/ha-eufy-sdk-bridge`
- `mega-yfue/ha-eufy-sdk`

The 0.5 SDK includes several techniques that explain the faster behavior in the current native app
and are relevant to Baiamonte: shared live sources, a short warm-source linger, first-frame retries,
PPCS relay fallback, explicit stored/live snapshot modes, HomeBase recording-page queries, T9000
portal command/media support, improved v2 thumbnails, and richer reported-property evidence.

## What is safe to adopt now

Baiamonte Eufy Security 9.6.36 adopts the lowest-risk live-media improvement: an explicitly opened
P2P stream remains warm for a bounded grace period after the last proxy viewer disconnects. A phone,
TV, or dashboard reconnect during that window reuses the source instead of repeating the complete
HomeBase/P2P handshake.

Safety properties:

- no dashboard probe or snapshot request starts live video;
- the default linger is eight seconds and the allowed range is 0–30 seconds;
- `0` restores immediate teardown;
- an explicit Stop bypasses the grace period;
- several simultaneous viewers share the same lifecycle and one viewer cannot stop another's feed;
- unloading the integration releases a warm P2P source.

## Why the production bridge is not replaced yet

The successor projects are a new protocol and entity contract, not an in-place package update. The
current bridge branch inspected on 2026-10-31 identifies as 0.6.0 but still pins SDK 0.4.0, while the
new T9000 and media work is in SDK 0.5.0. A direct swap would also change entity IDs and create a
separate Home Assistant device registry.

Baiamonte additionally depends on features not yet proven end-to-end through the successor HA stack:

- existing Schema-21 entities and automations;
- the Baiamonte/Miami split-account model;
- HomeBase Pro AIC event joins and recognition-image selection;
- Mega catalog diagnostics and current compatibility controls;
- the Baiamonte Security panel and durable snapshot cache;
- the rule that dashboards never auto-start battery-camera streams.

Running both bridges against the same account is not a safe shadow test because Eufy can invalidate
the other login session. Migration should therefore use recorded protocol fixtures first, then one
isolated account, and preserve the current entity IDs through an adapter before production cutover.

## Next migration gates

1. Pin the successor bridge and SDK to the same released cohort (SDK 0.5 or later).
2. Replay redacted Baiamonte device/event fixtures through its capability manifest.
3. Map successor device capabilities to the existing Baiamonte entity IDs.
4. Prove snapshot, PTZ, T9000 AIC/recording, and multi-view lifecycle parity.
5. Pilot on an isolated account without running both Eufy sessions concurrently.
6. Keep the current bridge available as a rollback until a full-day camera/event audit passes.
