#!/usr/bin/env bash
# Approve the platform's "Mastercard Open Finance data source" on each testnet's CURRENT oracle, for the income checks
# only (RENT_INCOME, ROYALTY_INCOME). It signs gaslessly (attestBySig); the relayer submits, so it needs no ETH.
# Usage: bash ~/diamondz-tokenize/web/scripts/approve-data-source.sh <env file with the deployer PRIVATE_KEY>
set -euo pipefail
ENV_FILE="${1:?usage: approve-data-source.sh <env file with PRIVATE_KEY>}"
cd "$(dirname "$0")/.."
DS=$(sed -n 's/^MC_DATA_SOURCE_ADDRESS=//p' ~/.diamondz-tokenize.env)
[ -n "$DS" ] || { echo "no MC_DATA_SOURCE_ADDRESS in ~/.diamondz-tokenize.env" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${PRIVATE_KEY:?PRIVATE_KEY not set in $ENV_FILE}"
for CHAIN in 84532 421614 46630; do
  echo "== chain $CHAIN"
  bun scripts/oracle.ts add-verifier --chain "$CHAIN" --address "$DS" --name "Mastercard Open Finance data source (platform)" --kinds RENT_INCOME,ROYALTY_INCOME --execute
done
echo
echo "DONE. Tell Claude it finished."
