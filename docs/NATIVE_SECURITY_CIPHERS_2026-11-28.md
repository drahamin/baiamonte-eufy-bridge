# Native security cipher lookup

Adapted from eufy-sdk 0.6.0, commit `0e431755e19a28248d032867b5c8544179670b37`:
[securityAppPost/getCiphers](https://github.com/mega-yfue/eufy-sdk/blob/0e431755e19a28248d032867b5c8544179670b37/src/transport/http/mega-client.ts).

The legacy P2P transport previously resolved gateway keys only through
`v2/app/cipher/get_ciphers`. The current SDK uses authenticated
`/v3/app/cipher/get_ciphers` with the station serial and station admin ID.
The security-app eufylife host needs a separate ECDH identity, its public
app bootstrap constant, `/v3/openapi/oauth/key/exchange`, and text/plain
encrypted data requests. Reusing the Mega openapi identity is incorrect.

The transition installs a narrow cipher provider on HTTPApi. A valid Mega
session is required; this provider never replays login or triggers a new
challenge. Empty, failed or timed-out native reads retain the existing
compatibility path, including callers without station context. Gateway header version selects the
required RSA/ECC key; compatibility fills missing key types without discarding
a valid native key of the other type.

Native reads are limited to 15 seconds overall and eight seconds per HTTP
request. Queued requests check cancellation before sending. Concurrent
matching requests join, and successful complete results are cached for 15
minutes within the token, station, owner and requested-ID scope (128-entry
cap). Empty/failing reads are never cached. A retired authentication context
cannot install a security identity or send/return a native data lookup. Security signature recovery only evicts
that security host, preserving the Mega login identity.

Protocol tests cover real ECDH request/response encryption for US/EU/IE,
content type, station/owner routing, identity recovery, cancellation,
positive-cache scope/expiry, malformed/unsolicited records, compatibility
fallback, concurrent requests and expired-session behavior. Field camera
recovery must be verified separately; this source change alone does not
establish it.
