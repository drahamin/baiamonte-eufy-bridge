# Baiamonte Eufy cloud migration contract

This fork is a transitional hybrid, designed to keep the Home Assistant installation useful while
Eufy completes the Mega migration and the community publishes native Mega inventory/control APIs.
It must never describe a legacy-backed capability as Mega-native.

## Capability ownership in `3.1.0-baiamonte.3`

| Capability | Current provider | Target provider |
| --- | --- | --- |
| Authentication and 2FA | Mega v6 | Mega v6 |
| FCM push registration | Mega v6 | Mega v6 |
| Houses, stations, and device inventory | Legacy cloud | Mega v6 |
| Cloud properties and cloud-only commands | Legacy cloud | Mega v6 |
| Shared-device invitations | Legacy cloud | Mega v6 |
| Streams and direct station/device commands | P2P | P2P |

P2P is direct device/station transport and is not classified as a legacy cloud server.

## Migration rules

1. New Mega code belongs in a dedicated Mega adapter. It must not route legacy paths through the
   signed Mega transport.
2. Legacy HTTP domains and paths remain isolated in `src/http/api.ts`.
3. A capability changes ownership in `cloudCapabilities.ts` only with a native implementation and
   automated tests.
4. Hybrid mode must log its active providers at startup. No fallback may be silent.
5. `mega_only` becomes selectable only after Mega owns inventory. Until then it would authenticate
   successfully but cannot expose Home Assistant entities, so the option must not be advertised.
6. The schema-21 WebSocket contract remains stable while providers are replaced behind it.

## Exit condition

Legacy cloud support can be removed when authentication, push, inventory, properties, invitations,
and cloud-only commands are all backed by native Mega endpoints for the Baiamonte device set. The
P2P layer remains for streaming and direct commands.
