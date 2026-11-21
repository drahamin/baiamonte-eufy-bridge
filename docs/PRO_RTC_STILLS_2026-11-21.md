# Explicit HomeBase Pro RTC stills

Bridge 1.6.73, client 4.1.1-mega.48, Security 9.6.47.

The Pro's attached cameras do not have the legacy P2P live path. A current
snapshot in the official app can coexist with a failed bridge P2P capture.
Adapt the proven [SDK RTC live path, #345](https://github.com/mega-yfue/eufy-sdk/pull/345)
for a **single explicitly requested still**, preserving the existing Mega
identity and authenticated RTC session setup. No second login or SDK daemon.

- Station `1350/1003`, stream ID 1, station channel 255 and the requested camera
  channel in `chn_list`; correlate start ACK/rejections and accept only `1300` HEVC frames on live link 5/channel 101.
- Decode with the existing PyAV dependency and encode one high-quality JPEG,
  capped at 2 MiB so the companion retains its existing WebSocket message limit.
- One Pro operation at a time, shared with roster/evidence reads. Reject a
  bridge-known active capture/view instead of replacing it. A refused start does not send a stop.
- Bound discovery/handshake/capture to the existing helper deadline, decoded
  frames to 120, input frames to 4 MiB and dimensions to 4096x2160. Bound worker
  queues/output backlog; stop and close DTLS on success, failure or cancellation.
  Parent ownership lasts through child teardown, with a bounded forced exit.
- Capture service routes attached Pro cameras through this extension and reports
  `station_model`. It preserves prior pixels/time on failure and confirms the
  durable cache before success. Both Pro and P2P captures roll back all candidate
  fields on failed/cancelled persistence, without overwriting a newer push image.
  Evidence maintenance remains non-live.
- The synthetic 64x48 HEVC fixture tests real decode/JPEG output. The image build
  runs the same codec self-test before an image can be installed.

This supplies a current manual still. It does not claim a full-frame picture of
an older event, recording download or automatic live viewing. The stored
full-frame Pro image request remains [upstream #558](https://github.com/mega-yfue/eufy-sdk/issues/558).
The separate v8 vault-image draft [#455](https://github.com/mega-yfue/eufy-sdk/pull/455)
was closed unmerged; it is not a verified decoder/key source.

Wire adaptation attribution and Apache-2.0 text ship in `pro-events/NOTICE` and
`pro-events/LICENSE-eufy-sdk`. The fixture contains no personal/camera imagery.
Hardware results must be reported separately from unit/build results.
