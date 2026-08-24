#!/usr/bin/env bash

set -euo pipefail

CLIENT_ROOT="eufy-mega-ws/vendor/eufy-security-client/src"
LEGACY_DOMAIN='extend\.eufylife\.com'

# Legacy server ownership must not spread into Mega, transition, P2P, or wrapper code.
domain_files="$(rg -l "$LEGACY_DOMAIN" "$CLIENT_ROOT" || true)"
test "$domain_files" = "$CLIENT_ROOT/http/api.ts"

# The machine-readable capability matrix and the human migration contract must remain present.
rg -q 'inventory: "legacy"' "$CLIENT_ROOT/http/cloudCapabilities.ts"
rg -q 'authentication: "mega"' "$CLIENT_ROOT/http/cloudCapabilities.ts"
rg -q 'livestream: "p2p"' "$CLIENT_ROOT/http/cloudCapabilities.ts"
rg -q 'No fallback may be silent' MIGRATION.md

# Home Assistant must install this fork separately from both upstream add-ons.
rg -q '^slug: baiamonte_eufy_hybrid$' eufy-mega-ws/config.yaml
