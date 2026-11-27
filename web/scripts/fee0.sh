#!/usr/bin/env bash
# Base Sepolia only: set the flat payout fee to $0 so payouts can be tested with a little test USDC.
# Usage: bash ~/diamondz-tokenize/web/scripts/fee0.sh <env file with the deployer PRIVATE_KEY>
set -euo pipefail
ENV_FILE="${1:-$HOME/brx-lz-oft/.env}"
cd "$(dirname "$0")/.."
set -a; . "$ENV_FILE"; set +a
bun scripts/oracle.ts payout-fee --chain 84532 --fee 0 --execute
