# Standalone camera live-start repair

Upstream: https://github.com/mega-yfue/eufy-sdk/releases/tag/v0.6.0 (2026-11-27), commit 0e43175; src/transport/p2p/p2p-session.ts startLiveJson/sendStartLiveOwnSession.

The prior adapter applied the full START_LIVE app fields only to GCM starts. Level-1 encrypted own-session starts also need these fields and frame type 11. This adaptation retains own-session and key-length checks, clear mode and HomeBase-attached framing. Tests decrypt the emitted packet and verify its command, encryption flag, frame type and payload. A passing unit test is not proof of live device recovery.

## RSA-negotiated standalone media follow-up

The same upstream source keeps `level1Key` separate from `level2EcbKey`.
`sendStartLiveOwnSession` and `stopLiveMedia` use the derived level-1 key
when no GCM, cipher-0 or gateway-refusal route applies. The RSA-unwrapped
ECB key serves ordinary set-payload commands, not this own-session media
start. The adapter now preserves that separation and leaves the negotiated
key installed for ordinary controls and HomeBase-attached media.

Regression packets are decrypted with the app-derived key after both
level-1 and RSA level-2 negotiation; matching stops use that same key.
This protocol repair still requires field validation and does not establish
that every affected camera has recovered.
