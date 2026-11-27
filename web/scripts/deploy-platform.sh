#!/usr/bin/env bash
# Deploy the platform contracts on one TESTNET (same stack Base Sepolia has):
#   AssetOracle (+ 8 class checklists) → CreAssetFeed (only where a Chainlink CRE forwarder exists)
#   → Distributor ($0 fee on testnets; RH testnet first gets a shared platform Test USD) → relayer gas
#   → the 3 TEST verifiers approved + a little gas each.
# Usage: bash ~/diamondz-tokenize/web/scripts/deploy-platform.sh <env file with PRIVATE_KEY> <chainId>
#   e.g. 421614 (Arbitrum Sepolia) or 46630 (Robinhood Chain testnet)
# The key is loaded into this process only; nothing prints it.
set -euo pipefail
ENV_FILE="${1:?usage: deploy-platform.sh <env file with PRIVATE_KEY> <chainId>}"
CHAIN="${2:?usage: deploy-platform.sh <env file with PRIVATE_KEY> <chainId>}"
case "$CHAIN" in 421614|46630) ;; *) echo "testnets only here (421614 or 46630); Base Sepolia is already done" >&2; exit 1;; esac
cd "$(dirname "$0")/.."
TV=~/.diamondz-tokenize-test-verifiers.env
TITLE=$(sed -n 's/^TEST_VERIFIER_TITLE_ADDRESS=//p' "$TV")
VAL=$(sed -n 's/^TEST_VERIFIER_VALUATION_ADDRESS=//p' "$TV")
INS=$(sed -n 's/^TEST_VERIFIER_INSURANCE_ADDRESS=//p' "$TV")
RELAYER=$(sed -n 's/^PAYOUT_RELAYER_ADDRESS=//p' ~/.diamondz-tokenize.env)
set -a; . "$ENV_FILE"; set +a
: "${PRIVATE_KEY:?PRIVATE_KEY not set in $ENV_FILE}"
o() { bun scripts/oracle.ts "$@" --chain "$CHAIN" --execute; }

bun scripts/oracle.ts whoami --chain "$CHAIN"

out=$(o deploy | tee /dev/stderr)
ORACLE=$(printf '%s' "$out" | sed -n 's/.*assetOracle: { address: "\(0x[0-9a-fA-F]\{40\}\)".*/\1/p')
[ -n "$ORACLE" ] || { echo "oracle address not found in output" >&2; exit 1; }

if [ "$CHAIN" = 421614 ]; then
  o deploy-feed --oracle "$ORACLE" --kinds NAV,REGISTRY
else
  echo "== no Chainlink CRE forwarder on chain $CHAIN: skipping CreAssetFeed"
fi

o add-verifier --oracle "$ORACLE" --address "$TITLE" --name "TEST Title & Legal (testnet only)" --kinds TITLE,MINERAL_TITLE,IP_OWNERSHIP,CAP_TABLE,REGISTRY
o add-verifier --oracle "$ORACLE" --address "$VAL" --name "TEST Valuation & Audit (testnet only)" --kinds VALUATION,RESERVES,PRODUCTION,FINANCIALS,NAV,AUTHENTICITY
o add-verifier --oracle "$ORACLE" --address "$INS" --name "TEST Insurance & Custody (testnet only)" --kinds INSURANCE,CUSTODY,RENT_INCOME,ROYALTY_INCOME,LOAN_TAPE,SERVICING
for a in "$TITLE" "$VAL" "$INS"; do o fund --address "$a" --eth 0.0015; done

if [ "$CHAIN" = 421614 ]; then
  o deploy-distributor --fee 0
  [ -n "$RELAYER" ] && o fund --address "$RELAYER" --eth 0.005
else
  # RH testnet has no stablecoin: one shared platform Test USD for practice purchases and payouts.
  tout=$(o deploy-testusd | tee /dev/stderr)
  TUSD=$(printf '%s' "$tout" | sed -n 's/.*stable: { address: "\(0x[0-9a-fA-F]\{40\}\)".*/\1/p')
  [ -n "$TUSD" ] || { echo "TestUSD address not found in output" >&2; exit 1; }
  o deploy-distributor --fee 0 --stable "$TUSD"
  [ -n "$RELAYER" ] && o fund --address "$RELAYER" --eth 0.002
fi
echo
echo "DONE. Paste everything above back to Claude."
