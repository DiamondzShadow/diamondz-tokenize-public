#!/usr/bin/env bash
# Run the oracle admin script (scripts/oracle.ts) signed by the deployer key from ~/.env (DEPLOYER_PK).
# Only oracle.ts, nothing else. oracle.ts stays read-only unless --execute is passed.
#   web/scripts/with-deployer.sh stellar-anchor --chain 84532 --network testnet --contract C… --class real-estate --execute
set -euo pipefail
cd "$(dirname "$0")/.."
PRIVATE_KEY="$(grep -E '^DEPLOYER_PK=' "$HOME/.env" | head -n1 | cut -d= -f2- | tr -d '"'"'"' \r')"
[ -n "$PRIVATE_KEY" ] || { echo "DEPLOYER_PK not found in ~/.env" >&2; exit 1; }
export PRIVATE_KEY
# Same RPCs as the API: Uniblock (free tier) for every EVM network we run.
UNIBLOCK_API_KEY="$(grep -E '^UNIBLOCK_API_KEY=' "$HOME/.diamondz-tokenize.env" | head -n1 | cut -d= -f2- | tr -d '"'"'"' \r')"
[ -n "$UNIBLOCK_API_KEY" ] && export UNIBLOCK_API_KEY
exec bun scripts/oracle.ts "$@"
