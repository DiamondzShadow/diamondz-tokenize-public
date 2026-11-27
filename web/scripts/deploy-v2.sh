#!/usr/bin/env bash
# v2 platform contracts on one TESTNET (needed for ERC-3643: v2 accepts a token's owner() as its admin).
#   AssetOracle v2 (+ 8 class checklists) → CreAssetFeed for it (where a Chainlink CRE forwarder exists)
#   → the 3 TEST verifiers approved on it → Distributor v2 ($0 fee, the network's stablecoin)
#   → gas for the platform's T-REX relayer.
# Existing offerings keep their v1 oracle (their sale's oracle can't change); the API reads each sale's own oracle.
# Usage: bash ~/diamondz-tokenize/web/scripts/deploy-v2.sh <env file with the deployer PRIVATE_KEY> <chainId>
#   84532 (Base Sepolia) · 421614 (Arbitrum Sepolia) · 46630 (Robinhood Chain testnet)
# Everything is also written to ~/diamondz-tokenize/deploy-logs/ (long runs get moved to the background).
set -euo pipefail
ENV_FILE="${1:?usage: deploy-v2.sh <env file with PRIVATE_KEY> <chainId>}"
CHAIN="${2:?usage: deploy-v2.sh <env file with PRIVATE_KEY> <chainId>}"
case "$CHAIN" in 84532|421614|46630) ;; *) echo "testnets only: 84532, 421614 or 46630" >&2; exit 1;; esac
cd "$(dirname "$0")/.."
mkdir -p ../deploy-logs
LOG="../deploy-logs/v2-$CHAIN-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
echo "log: $(cd ../deploy-logs && pwd)/$(basename "$LOG")"

TV=~/.diamondz-tokenize-test-verifiers.env
TITLE=$(sed -n 's/^TEST_VERIFIER_TITLE_ADDRESS=//p' "$TV")
VAL=$(sed -n 's/^TEST_VERIFIER_VALUATION_ADDRESS=//p' "$TV")
INS=$(sed -n 's/^TEST_VERIFIER_INSURANCE_ADDRESS=//p' "$TV")
TREX_RELAYER=$(sed -n 's/^TREX_RELAYER_ADDRESS=//p' ~/.diamondz-tokenize.env)
[ -n "$TREX_RELAYER" ] || { echo "no TREX_RELAYER_ADDRESS in ~/.diamondz-tokenize.env" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${PRIVATE_KEY:?PRIVATE_KEY not set in $ENV_FILE}"
o() { bun scripts/oracle.ts "$@" --chain "$CHAIN" --execute; }

bun scripts/oracle.ts whoami --chain "$CHAIN"

out=$(o deploy | tee /dev/stderr)
ORACLE=$(printf '%s' "$out" | sed -n 's/.*assetOracle: { address: "\(0x[0-9a-fA-F]\{40\}\)".*/\1/p')
[ -n "$ORACLE" ] || { echo "oracle address not found in output" >&2; exit 1; }

if [ "$CHAIN" != 46630 ]; then
  o deploy-feed --oracle "$ORACLE" --kinds NAV,REGISTRY
else
  echo "== no Chainlink CRE forwarder on chain $CHAIN: skipping CreAssetFeed"
fi

o add-verifier --oracle "$ORACLE" --address "$TITLE" --name "TEST Title & Legal (testnet only)" --kinds TITLE,MINERAL_TITLE,IP_OWNERSHIP,CAP_TABLE,REGISTRY
o add-verifier --oracle "$ORACLE" --address "$VAL" --name "TEST Valuation & Audit (testnet only)" --kinds VALUATION,RESERVES,PRODUCTION,FINANCIALS,NAV,AUTHENTICITY
o add-verifier --oracle "$ORACLE" --address "$INS" --name "TEST Insurance & Custody (testnet only)" --kinds INSURANCE,CUSTODY,RENT_INCOME,ROYALTY_INCOME,LOAN_TAPE,SERVICING

o deploy-distributor --fee 0
if [ "$CHAIN" = 46630 ]; then o fund --address "$TREX_RELAYER" --eth 0.002; else o fund --address "$TREX_RELAYER" --eth 0.005; fi
echo
echo "DONE. Tell Claude it finished (the log above is saved)."
