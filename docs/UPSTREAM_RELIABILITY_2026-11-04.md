# Upstream reliability changes — 2026-11-04

Release: bridge 1.6.63, vendored client 4.1.1-mega.43, companion 9.6.40. Existing
Schema-21 entities are retained. These are adaptations to our transport, not installation of
the successor SDK alongside the existing Eufy account session.

## Adopted behavior

- [SDK #518](https://github.com/mega-yfue/eufy-sdk/pull/518): S380 camera media uses a
  separate ephemeral connection per channel. The map is installed synchronously before start,
  so concurrent starts share one connection. Command results and media/talkback events retain
  the original station identity. A startup timeout, failure, stop, or station shutdown releases
  that channel's resources without closing siblings or control. Existing live-duration limits
  and explicit capture controls remain active.
- [Bridge #169](https://github.com/mega-yfue/ha-eufy-sdk-bridge/pull/169) and
  [SDK #545](https://github.com/mega-yfue/eufy-sdk/pull/545): retry stored-cover recovery
  after temporary silence/failure. Connected stations are revisited in rotating batches of two,
  at most once per station per ten minutes. Stable cloud URLs are fetched again at the existing
  25-minute cadence. A missed local download cannot permanently suppress subsequent attempts.
- [SDK #535](https://github.com/mega-yfue/eufy-sdk/pull/535): assemble full 64,000-byte
  chunks only with matching sequence and timestamps within 100 ms of the first chunk, including
  32-bit wrap. Truncated/orphan units are discarded; retained bytes are bounded. Complete units
  are emitted immediately rather than waiting for the next frame. RSA 0x40 keyframes are recognized
  without changing the ECC decoder's bit-0 interpretation (the technique in open SDK #449).
- [SDK #544](https://github.com/mega-yfue/eufy-sdk/pull/544) and
  [SDK #542](https://github.com/mega-yfue/eufy-sdk/pull/542): ignore empty/truncated audio
  and malformed UDP/media headers before parsing.
- [SDK #525](https://github.com/mega-yfue/eufy-sdk/pull/525): decompress whole Pro portal
  packets with a 16 MiB bound; database reads carry unique increasing millisecond transactions.
  Late optional-roster replies can enrich names but cannot advance a newer event request.
  Image replies remain matched to the requested file path. Duplicate/unknown transactions are
  ignored, and evidence timers are cancelled on shutdown. A firmware that rejects or stays silent
  on the AIC query gets one bounded whole-history-table fallback for saved covers. That fallback
  does not fabricate AI evidence, and its response cannot be confused with a late AIC response.
- [SDK #561](https://github.com/mega-yfue/eufy-sdk/pull/561): end an evidence query when
  its signalling socket closes, including failed receiver tasks, and release the peer/resources.

## Scope and remaining transport work

The companion waits 63 seconds for AIC replies, inside the coordinator's 64-second Pro
operation and 70-second overall local-query budget. One Pro query and one ordinary station
query can progress independently. The Pro is not retried through an unsupported direct index.

Live validation found a capture/publication ordering gap. Companion 9.6.40 publishes an explicit
frame after stream cleanup, waits for the coalesced cache writer, verifies stored bytes and capture
time, and rotates the camera proxy token before reporting success. A failed write or retired product
is not reported as a fresh capture. Behavioral tests simulate an older picture replayed on stop.

No automatic live video is introduced. Background image maintenance uses saved covers only.
An explicit user capture still opens a bounded stream through the existing capture service.

The successor's full PPCS relay fallback (#474) remains a separate transport migration: it changes
lookup/relay handshakes and key timing and is not supplied by these fixes. T8222 snapshot recovery
and T8134 relay reachability require live model-specific verification; T8200/T8201 upstream results
are not evidence that every doorbell model will work.

The successor bridge's unrelated go2rtc environment settings, robot/SmartDrop actions, and different
HA registry contract are not imported into this bridge. Our current configuration, identities,
durable snapshot cache, split-site accounts, and Pro AI/evidence joins remain in place.
