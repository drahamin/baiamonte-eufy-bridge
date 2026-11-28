# Standalone camera live-start repair

Upstream: https://github.com/mega-yfue/eufy-sdk/releases/tag/v0.6.0 (2026-11-27), commit 0e43175; src/transport/p2p/p2p-session.ts startLiveJson/sendStartLiveOwnSession.

The prior adapter applied the full START_LIVE app fields only to GCM starts. Level-1 encrypted own-session starts also need these fields and frame type 11. This adaptation retains own-session and key-length checks, clear mode and HomeBase-attached framing. Tests decrypt the emitted packet and verify its command, encryption flag, frame type and payload. A passing unit test is not proof of live device recovery.
