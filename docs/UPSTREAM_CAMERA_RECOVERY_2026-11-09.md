# Camera stored-media recovery — 2026-11-09

Bridge 1.6.70 / client 4.1.1-mega.45 / companion unchanged at 9.6.42.

## Search and baseline

Compared Baiamonte main af4fc26 against upstream stable releases, the successor
beta-0.6.0 branch, npm tags, merged/open PRs, issue evidence and active forks.
Sources included the four mega-yfue SDK/HA repositories; archived bropat client
and WebSocket repositories; fuatakgun/eufy_security; jpark40; keesmod client and
HA viewer; mscodemonkey gateway; alaraun Python client; Homebridge; and ioBroker.
This is a public-source audit, not access to unpublished vendor code.

SDK stable remains 0.5.0; npm beta is 0.6.0-beta.32, published November 9.
The successor is not a drop-in replacement for the Schema-21/HA entity contract.

## Adopted and adapted

- [SDK #502](https://github.com/mega-yfue/eufy-sdk/pull/502): stored image/database
  requests use clear framing only after an own-session camera reports cipher 0,
  while no established level-2 session exists. Clear commands share the existing
  per-connection counter. Clear database/image DATA replies enter the established
  normalizers; command acknowledgements keep their existing route. Property
  writes, attached camera channels, unknown ciphers and level-2 sessions retain
  their original encrypted framing. The current client already serializes the
  gateway key reply before queued reads, so no additional per-read wait is added.
- Standalone image requests use channel 0, matching their database and live
  session, rather than the HomeBase broadcast channel 255. Actual HomeBases retain
  255. A Pro file request fails promptly instead of starting unsupported P2P;
  embedded authenticated RTC images and cloud sources retain their existing paths.
- [SDK #593](https://github.com/mega-yfue/eufy-sdk/pull/593): Pro type/T9000 serials
  are excluded from station P2P connection and reconnect scheduling. Other station
  types retain P2P. The portal AIC helper and compatibility session flag remain.
- [SDK #592](https://github.com/mega-yfue/eufy-sdk/pull/592), open proposal:
  the Pro-only helper now ends a pre-open hub hangup promptly. Terminal peer
  states were already handled. Cleanup reports only fixed phase/peer/channel
  state, never account identifiers, tokens, paths or SDP.
- [SDK #599](https://github.com/mega-yfue/eufy-sdk/pull/599): S380/T8030 stored
  download uses string-pair command 1024, not the former unsupported RSA-key
  SET_PAYLOAD wrapper. Full paths must exactly match the camera channel, month
  and 14-digit recording name; bare names build the same canonical path. The
  T8030 binary recording route preserves clear payload bytes after each 22-byte
  header, including 400000-byte split keyframes, without live ECC/RSA decoding.
  Other stations and live video keep their existing decoder. A foreign camera's
  frames or finish cannot terminate or contaminate the active recording.
- HomeBase downloads reserve a single station lane before the first asynchronous
  start, reject an overlapping camera download and release failed starts.
  Empty transfers also emit completion to release subscriber state after timeout.
- [SDK #600](https://github.com/mega-yfue/eufy-sdk/pull/600): empty table handling
  is made explicit with array guards. Empty strings already iterated as no rows
  in the legacy parser; null/malformed values now also complete safely. This is
  defensive hardening, not evidence that the successor parser's exact bug existed.

## Limits and deferred work

- #599 hardware evidence is T8030 firmware 1.2.0.1; it does not establish Pro
  stored recording support. Our transport uses the camera's FPS header instead
  of the successor's sequence-derived FPS, so open #604's size-change counting
  code is not copied into an unrelated decoder.
- Full PPCS relay [#474](https://github.com/mega-yfue/eufy-sdk/pull/474) remains a
  separate complete transport adapter; no partial relay or port-sweep patch is
  enabled. T86P2 remote-NAT recovery is not claimed solved by these changes.
- E10 experimental H264 [#718](https://github.com/mscodemonkey/eufy-mega-security/pull/718)
  still lacks physical playback confirmation. v8 thumbnail decoder #455 remains
  a draft with unresolved legitimate vault-key acquisition. Neither is enabled.
- No complete native Mega security catalog or safe names for all unknown IDs were
  found. Existing catalog evidence and compatibility controls remain necessary.
- No changes start live video automatically. Stored-media tests and live validation
  must distinguish a returned reference from actual image/clip bytes, and a cache
  read from a genuinely newer capture timestamp.

## Verification

Behavioral regressions cover clear/encrypted packet bytes and counters, normalized
DATA replies, malformed empty tables, Pro connection/reconnect and pre-open hangup,
standalone/HomeBase image channels, S380 command/path ownership, split stored frame
bytes, malformed/foreign frames, finish channel and empty-transfer cleanup, and
concurrent station download admission/release. Existing client/server/Python and
configuration suites, static checks, builds and hosted container CI are required.
