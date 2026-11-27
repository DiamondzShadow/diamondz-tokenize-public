#!/usr/bin/env bash
# Base Sepolia: deploy the platform payout contract (flat $25 per payout, DRAFT) and give the gas-free-claim relayer gas.
# Usage: bash ~/diamondz-tokenize/web/scripts/setup-payouts.sh <env file with the deployer PRIVATE_KEY>
set -euo pipefail
ENV_FILE="${1:?usage: setup-payouts.sh <env file with PRIVATE_KEY>}"
cd "$(dirname "$0")/.."
RELAYER=$(sed -n 's/^PAYOUT_RELAYER_ADDRESS=//p' ~/.diamondz-tokenize.env)
[ -n "$RELAYER" ] || { echo "no PAYOUT_RELAYER_ADDRESS in ~/.diamondz-tokenize.env" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${PRIVATE_KEY:?PRIVATE_KEY not set in $ENV_FILE}"
bun scripts/oracle.ts whoami --chain 84532
bun scripts/oracle.ts deploy-distributor --chain 84532 --fee 25 --execute
bun scripts/oracle.ts fund --chain 84532 --address "$RELAYER" --eth 0.01 --execute
echo
echo "DONE. Paste everything above back to Claude."
