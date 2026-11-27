#!/usr/bin/env bash
# Base Sepolia only: approve the three TEST verifier wallets on the AssetOracle and give each a little gas.
# Usage: bash ~/diamondz-tokenize/web/scripts/setup-test-verifiers.sh <env file with the deployer PRIVATE_KEY>
# Test verifier addresses come from ~/.diamondz-tokenize-test-verifiers.env (their keys are not read here).
set -euo pipefail
ENV_FILE="${1:?usage: setup-test-verifiers.sh <env file with PRIVATE_KEY>}"
cd "$(dirname "$0")/.."
TV=~/.diamondz-tokenize-test-verifiers.env
TITLE=$(sed -n 's/^TEST_VERIFIER_TITLE_ADDRESS=//p' "$TV")
VAL=$(sed -n 's/^TEST_VERIFIER_VALUATION_ADDRESS=//p' "$TV")
INS=$(sed -n 's/^TEST_VERIFIER_INSURANCE_ADDRESS=//p' "$TV")
set -a; . "$ENV_FILE"; set +a
: "${PRIVATE_KEY:?PRIVATE_KEY not set in $ENV_FILE}"
o() { bun scripts/oracle.ts "$@" --chain 84532 --execute; }
bun scripts/oracle.ts whoami --chain 84532
o add-verifier --address "$TITLE" --name "TEST Title & Legal (testnet only)" --kinds TITLE,MINERAL_TITLE,IP_OWNERSHIP,CAP_TABLE,REGISTRY
o add-verifier --address "$VAL" --name "TEST Valuation & Audit (testnet only)" --kinds VALUATION,RESERVES,PRODUCTION,FINANCIALS,NAV,AUTHENTICITY
o add-verifier --address "$INS" --name "TEST Insurance & Custody (testnet only)" --kinds INSURANCE,CUSTODY,RENT_INCOME,ROYALTY_INCOME,LOAN_TAPE,SERVICING
for a in "$TITLE" "$VAL" "$INS"; do o fund --address "$a" --eth 0.003; done
echo
echo "DONE. Paste everything above back to Claude."
