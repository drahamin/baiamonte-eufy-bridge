#!/usr/bin/env bash

set -euo pipefail

CLIENT_ROOT="eufy-mega-ws/vendor/eufy-security-client/src"
LEGACY_DOMAIN='extend\.eufylife\.com'

# Legacy server ownership must not spread into Mega, transition, P2P, or wrapper code.
if command -v rg >/dev/null 2>&1; then
    search_files() { rg -l "$1" "$2" || true; }
    assert_file() { rg -q "$1" "$2"; }
else
    search_files() { grep -R -l -E "$1" "$2" || true; }
    assert_file() { grep -q -E "$1" "$2"; }
fi

domain_files="$(search_files "$LEGACY_DOMAIN" "$CLIENT_ROOT")"
test "$domain_files" = "$CLIENT_ROOT/http/api.ts"

# The machine-readable capability matrix and the human migration contract must remain present.
assert_file 'inventory: "legacy"' "$CLIENT_ROOT/http/cloudCapabilities.ts"
assert_file 'authentication: "mega"' "$CLIENT_ROOT/http/cloudCapabilities.ts"
assert_file 'livestream: "p2p"' "$CLIENT_ROOT/http/cloudCapabilities.ts"
assert_file 'No fallback may be silent' MIGRATION.md

# Home Assistant must install this fork separately from both upstream add-ons.
assert_file '^slug: baiamonte_eufy_hybrid$' eufy-mega-ws/config.yaml
