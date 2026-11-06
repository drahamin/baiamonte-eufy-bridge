# Pro records, roster and camera reliability — 2026-11-06

Bridge 1.6.64 / client 4.1.1-mega.44 / Security 9.6.41.

- The Pro helper discovers its RTC service region using the portal WEB identity,
  independently of account country and PHONE login. Discovery is unauthenticated,
  bounded to five seconds and 64 KiB, refuses redirects, and accepts only the
  US/EU/IE Mega domains. Country remains on `Web-Country`; the discovered cluster
  goes into RTC authentication. No account migration or token destination override.
  Adapted from SDK [#450](https://github.com/mega-yfue/eufy-sdk/pull/450) and the
  released gateway's `nvr-service-region.ts`. Baiamonte's current country is US and
  its WEB estimate also returns US: this fix is not evidence that its remaining
  Pro query failure is caused by a regional mismatch.
- The authenticated Security panel offers an administrator-only `homebase_tables`
  read, a bounded face roster with unique exact HA person links, and a searchable
  recording table with existing protected media actions. It exposes no database
  file paths, face templates, authentication fields or numeric identity keys.
  Rosters can be empty independently of recordings and carry their own read time;
  warnings remain visible if cached roster data outlives a failed query.
- S380 PTZ uses the already-streaming camera's dedicated media session, preserving
  control/sibling isolation and falling back to ordinary control when stopped.
  Adapted from bridge [#149](https://github.com/mega-yfue/ha-eufy-sdk-bridge/pull/149).
- `s380_person_from_record` is an integration option, default off. Only T8030
  records interpret trigger type 4 as person, following bridge
  [#141](https://github.com/mega-yfue/ha-eufy-sdk-bridge/pull/141). With the option on,
  a rising motion report schedules a three-second delayed stored-record read,
  serialized with a queue of at most eight cameras and one read/minute/camera.
  Only same-camera recent records within the detection window can pulse the
  existing person sensor for ten seconds. Real person pushes and reused record
  IDs suppress duplicates. The optional `eufy_security_person_from_record` bus
  event explicitly says recognized=false. No person identity is inferred.
- Evidence calls during bridge inventory initialization return a retry warning;
  empty station inventories do not reach `asyncio.wait([])`. Undated image reads
  retain unknown capture time instead of using the download time. Camera metadata
  distinguishes bridge availability, inventory presence, active video and image
  time basis; a cached cover is not proof that a camera is online.

## Relay evaluation

SDK [#474](https://github.com/mega-yfue/eufy-sdk/pull/474) is merged upstream, but
does not apply directly to this client. It adds the complete ListReq/hello/port/
registration/ready state machine, DNS/source validation and new relay messages,
and raises connect timeout from 15 to 45 seconds to leave room after 24 acknowledged
lookup rounds. Our client has a legacy TURN path, different socket/session owners,
and 30-second media-start/companion waits. Copying only its packet constants or
raising waits would leave an incomplete handshake and worsen blocked-camera
latency. The full relay transport is therefore not enabled in this release;
it requires its own adapter and hardware validation on an unreachable camera.

No automatic live streams are introduced. Table reads use the existing bounded
control channel, and saved-video downloads remain explicit.
