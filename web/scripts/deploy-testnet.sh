#!/usr/bin/env bash
# One-shot Base Sepolia deploy of the proof-of-asset stack: AssetOracle (+ all 8 class checklists) and the Chainlink
# CRE receiver CreAssetFeed (approved on the oracle to sign NAV + REGISTRY).
# Usage (from anywhere):  bash ~/diamondz-tokenize/web/scripts/deploy-testnet.sh <env file that has PRIVATE_KEY>
# The key is loaded into this process only; nothing prints it.
set -euo pipefail
ENV_FILE="${1:?usage: deploy-testnet.sh <env file with PRIVATE_KEY>}"
cd "$(dirname "$0")/.."
set -a; . "$ENV_FILE"; set +a
: "${PRIVATE_KEY:?PRIVATE_KEY not set in $ENV_FILE}"

bun scripts/oracle.ts whoami --chain 84532
out=$(bun scripts/oracle.ts deploy --chain 84532 --execute | tee /dev/stderr)
oracle=$(printf '%s' "$out" | sed -n 's/.*assetOracle: { address: "\(0x[0-9a-fA-F]\{40\}\)".*/\1/p')
[ -n "$oracle" ] || { echo "oracle address not found in output" >&2; exit 1; }
bun scripts/oracle.ts deploy-feed --chain 84532 --oracle "$oracle" --kinds NAV,REGISTRY --execute
echo
echo "DONE. Paste everything above back to Claude."
