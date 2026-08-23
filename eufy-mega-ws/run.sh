#!/usr/bin/with-contenv bashio

umask 077

CONFIG_PATH=/data/eufy-security-ws-config.json

USERNAME="$(bashio::config 'username')"
PASSWORD="$(bashio::config 'password')"
COUNTRY="$(bashio::config 'country')"
EVENT_DURATION_SECONDS="$(bashio::config 'event_duration')"
POLLING_INTERVAL_MINUTES="$(bashio::config 'polling_interval')"
ACCEPT_INVITATIONS="$(bashio::config 'accept_invitations')"
TRUSTED_DEVICE_NAME="$(bashio::config 'trusted_device_name')"
SNAPSHOT_CACHE="$(bashio::config 'snapshot_cache')"
STATIONS_JSON="$(bashio::config 'stations')"

PORT_OPTION=""
if bashio::config.has_value 'port'; then
    PORT_OPTION="--port $(bashio::config 'port')"
fi

DEBUG_OPTION=""
if bashio::config.true 'debug'; then
    DEBUG_OPTION="-v"
fi

IPV4_FIRST_NODE_OPTION=""
if bashio::config.true 'ipv4first'; then
    IPV4_FIRST_NODE_OPTION="--dns-result-order=ipv4first"
fi

JSON_STRING="$(jq -n \
    --arg username "$USERNAME" \
    --arg password "$PASSWORD" \
    --arg country "$COUNTRY" \
    --arg trusted_device_name "$TRUSTED_DEVICE_NAME" \
    --argjson event_duration_seconds "$EVENT_DURATION_SECONDS" \
    --argjson polling_interval_minutes "$POLLING_INTERVAL_MINUTES" \
    --argjson accept_invitations "$ACCEPT_INVITATIONS" \
    --argjson snapshot_cache "$SNAPSHOT_CACHE" \
    --argjson stations "$STATIONS_JSON" \
    '(
      {
        username: $username,
        password: $password,
        persistentDir: "/data",
        country: $country,
        eventDurationSeconds: $event_duration_seconds,
        pollingIntervalMinutes: $polling_interval_minutes,
        acceptInvitations: $accept_invitations,
        snapshotCache: $snapshot_cache,
        enableEmbeddedPKCS1Support: true
      }
      + (if $trusted_device_name != "" then {trustedDeviceName: $trusted_device_name} else {} end)
      + (if ($stations | length) > 0 then {
          stationIPAddresses: ($stations | map({key: .serial_number, value: .ip_address}) | from_entries)
        } else {} end)
    )')"

if bashio::config.has_value 'username' && bashio::config.has_value 'password'; then
    echo "$JSON_STRING" > "$CONFIG_PATH"
    chmod 0600 "$CONFIG_PATH"
    # No --security-revert=CVE-2023-46809: Node 24 dropped that revert token and
    # aborts on startup if it's passed. eufy-security-ws@3.0.1 instead defaults
    # config.enableEmbeddedPKCS1Support=true, so eufy-security-client uses its
    # pure-JS PKCS#1 v1.5 path and the P2P RSA handshake keeps working.
    # See bropat/eufy-security-ws#564.
    exec /usr/bin/node $IPV4_FIRST_NODE_OPTION /usr/src/app/node_modules/eufy-security-ws/dist/bin/server.js --host 0.0.0.0 --config "$CONFIG_PATH" $DEBUG_OPTION $PORT_OPTION
else
    bashio::log.fatal "Required parameters username and/or password not set. Starting aborted!"
fi
