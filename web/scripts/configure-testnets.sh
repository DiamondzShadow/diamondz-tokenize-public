#!/usr/bin/env bash
# Re-applies the proof-of-asset check kinds and class checklists (incl. Film & TV) on every testnet oracle.
# Signs with the deployer key from ~/.env (DEPLOYER_PK). Pass --dry to only print the calls.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ~/.env; set +a
export PRIVATE_KEY="${PRIVATE_KEY:-${DEPLOYER_PK:-}}"
EXEC="--execute"; [ "${1:-}" = "--dry" ] && EXEC=""
for c in 84532 421614 46630; do
  bun scripts/oracle.ts configure --chain "$c" $EXEC
done
