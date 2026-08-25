#!/usr/bin/env bash

set -euo pipefail

CONFIG_PATH="$(mktemp /tmp/eufy-mega-ws-config.XXXXXX.json)"
RUN_SCRIPT="$(mktemp /tmp/eufy-mega-ws-run.XXXXXX.sh)"
export BAIAMONTE_SKIP_DASHBOARD=true
SERVER_INVOCATION=""
trap 'rm "$CONFIG_PATH" "$RUN_SCRIPT"' EXIT

function bashio::config() {
    case "$1" in
        username) printf %s "test@example.com" ;;
        password) printf %s "secret" ;;
        country) printf %s "US" ;;
        event_duration) printf %s "" ;;
        polling_interval) printf %s "5" ;;
        accept_invitations) printf %s "true" ;;
        trusted_device_name) printf %s "HA Mega" ;;
        snapshot_cache) printf %s "true" ;;
        mega_inventory_diagnostics) printf %s "true" ;;
        firmware_research) printf %s "false" ;;
        stations) printf %s '[{"serial_number":"T8030ABC","ip_address":"192.168.1.10"}]' ;;
        port) printf %s "3000" ;;
    esac
}

function bashio::config.has_value() {
    case "$1" in
        username | password | port) return 0 ;;
        *) return 1 ;;
    esac
}

function bashio::config.true() {
    return 1
}

function bashio::log.fatal() {
    printf 'fatal: %s\n' "$*" >&2
    return 1
}

function bashio::log.warning() {
    printf 'warning: %s\n' "$*" >&2
}

# Capture the final server invocation instead of replacing this test process.
function exec() {
    SERVER_INVOCATION="$*"
    printf 'server invocation: %s\n' "$*"
}

sed "s#^CONFIG_PATH=.*#CONFIG_PATH=${CONFIG_PATH}#" eufy-mega-ws/run.sh > "$RUN_SCRIPT"
source "$RUN_SCRIPT"

jq -e '
    .username == "test@example.com"
    and .password == "secret"
    and .country == "US"
    and .eventDurationSeconds == 10
    and .pollingIntervalMinutes == 5
    and .acceptInvitations == true
    and .snapshotCache == true
    and .firmwareResearch == false
    and .firmwareResearchDir == "/share/baiamonte-eufy/firmware"
    and .trustedDeviceName == "HA Mega"
    and .stationIPAddresses.T8030ABC == "192.168.1.10"
    and .enableEmbeddedPKCS1Support == true
' "$CONFIG_PATH" >/dev/null

test "$(stat -c '%a' "$CONFIG_PATH" 2>/dev/null || stat -f '%Lp' "$CONFIG_PATH")" = "600"
[[ "$SERVER_INVOCATION" == *"--host 127.0.0.1"* ]]
