#!/usr/bin/with-contenv bashio

umask 077

CONFIG_PATH=/data/eufy-security-ws-config.json

EUFY_USERNAME="$(bashio::config 'username')"
EUFY_PASSWORD="$(bashio::config 'password')"
EUFY_COUNTRY="$(bashio::config 'country')"
TRUSTED_DEVICE_NAME="$(bashio::config 'trusted_device_name')"
CONTROL_AUDIT_TARGET="$(bashio::config 'control_audit_target')"

read_integer_option() {
    local option="$1"
    local fallback="$2"
    local value
    value="$(bashio::config "$option")"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
        printf '%s' "$value"
    else
        bashio::log.warning "Invalid or missing ${option}; using ${fallback}"
        printf '%s' "$fallback"
    fi
}

read_boolean_option() {
    local option="$1"
    local fallback="$2"
    local value
    value="$(bashio::config "$option")"
    value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
    case "$value" in
        true | 1 | yes | on) printf 'true' ;;
        false | 0 | no | off) printf 'false' ;;
        *)
            bashio::log.warning "Invalid or missing ${option}; using ${fallback}"
            printf '%s' "$fallback"
            ;;
    esac
}

read_array_option() {
    local option="$1"
    local value
    value="$(bashio::config "$option")"
    if jq -e 'type == "array"' >/dev/null 2>&1 <<<"$value"; then
        printf '%s' "$value"
    else
        bashio::log.warning "Invalid or missing ${option}; using an empty list"
        printf '[]'
    fi
}

EVENT_DURATION_SECONDS="$(read_integer_option 'event_duration' '10')"
POLLING_INTERVAL_MINUTES="$(read_integer_option 'polling_interval' '10')"
ACCEPT_INVITATIONS="$(read_boolean_option 'accept_invitations' 'true')"
SNAPSHOT_CACHE="$(read_boolean_option 'snapshot_cache' 'true')"
MEGA_INVENTORY_DIAGNOSTICS="$(read_boolean_option 'mega_inventory_diagnostics' 'true')"
FIRMWARE_RESEARCH="$(read_boolean_option 'firmware_research' 'false')"
STATIONS_JSON="$(read_array_option 'stations')"

BRIDGE_PORT="$(read_integer_option 'port' '3000')"
PORT_OPTION="--port ${BRIDGE_PORT}"

DEBUG_OPTION=""
if bashio::config.true 'debug'; then
    DEBUG_OPTION="-v"
fi

IPV4_FIRST_NODE_OPTION=""
if bashio::config.true 'ipv4first'; then
    IPV4_FIRST_NODE_OPTION="--dns-result-order=ipv4first"
fi

JSON_STRING="$(jq -n \
    --arg username "$EUFY_USERNAME" \
    --arg password "$EUFY_PASSWORD" \
    --arg country "$EUFY_COUNTRY" \
    --arg trusted_device_name "$TRUSTED_DEVICE_NAME" \
    --argjson event_duration_seconds "$EVENT_DURATION_SECONDS" \
    --argjson polling_interval_minutes "$POLLING_INTERVAL_MINUTES" \
    --argjson accept_invitations "$ACCEPT_INVITATIONS" \
    --argjson snapshot_cache "$SNAPSHOT_CACHE" \
    --argjson mega_inventory_diagnostics "$MEGA_INVENTORY_DIAGNOSTICS" \
    --argjson firmware_research "$FIRMWARE_RESEARCH" \
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
        megaInventoryDiagnostics: $mega_inventory_diagnostics,
        firmwareResearch: $firmware_research,
        firmwareResearchDir: "/share/baiamonte-eufy/firmware",
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
    export BAIAMONTE_BRIDGE_PORT="$BRIDGE_PORT"
    export BAIAMONTE_DASHBOARD_PORT="8097"
    export BAIAMONTE_CONTROL_AUDIT_TARGET="$CONTROL_AUDIT_TARGET"
    if [[ "${BAIAMONTE_SKIP_DASHBOARD:-false}" != "true" ]]; then
        /usr/bin/node /opt/baiamonte-eufy-dashboard/server.cjs &
    fi
    # Home Assistant and the dashboard are local consumers. Keeping the command
    # socket on loopback prevents unauthenticated camera controls from being
    # reachable by arbitrary LAN clients.
    exec /usr/bin/node $IPV4_FIRST_NODE_OPTION /usr/src/app/node_modules/eufy-security-ws/dist/bin/server.js --host 127.0.0.1 --config "$CONFIG_PATH" $DEBUG_OPTION $PORT_OPTION
else
    bashio::log.fatal "Required parameters username and/or password not set. Starting aborted!"
fi
