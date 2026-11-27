#!/usr/bin/env bash
# Full platform stack on one of the TESTNETS added 2026-11-27 (Arc, Avalanche Fuji, XRPL EVM, HyperEVM):
#   AssetOracle v2 (+ class checklists) → the 3 TEST verifiers approved + gas each
#   → platform Test USD (only where Circle has no USDC: XRPL EVM) → Distributor ($0 fee on testnets)
#   → gas for the payout relayer and the T-REX relayer → ERC-3643 core (T-REX factory, identity factory, rules module).
# Usage: bash ~/diamondz-tokenize/web/scripts/deploy-network.sh <chainId>      (resume: ORACLE=0x… bash … <chainId>)
#   5042002 (Arc Testnet) · 43113 (Avalanche Fuji) · 1449000 (XRPL EVM Testnet) · 998 (HyperEVM Testnet)
# Signs with the deployer key from ~/.env (DEPLOYER_PK) and the T-REX relayer key from ~/.diamondz-tokenize.env.
# Keys stay in this process; nothing prints them. Output (addresses to paste into chains.ts) → deploy-logs/.
set -euo pipefail
CHAIN="${1:?usage: deploy-network.sh <chainId>}"
# Gas money per wallet, in each network's own gas token (Arc pays gas in USDC, XRPL EVM in XRP).
case "$CHAIN" in
  5042002) VER=0.1;   PAYOUT=0.5;   TREX=2 ;;
  43113)   VER=0.005; PAYOUT=0.01;  TREX=0.02 ;;
  1449000) VER=0.05;  PAYOUT=0.2;   TREX=0.5 ;;
  998)     VER=0.001; PAYOUT=0.005; TREX=0.01 ;;
  *) echo "testnets added 2026-11-27 only: 5042002, 43113, 1449000 or 998" >&2; exit 1 ;;
esac
cd "$(dirname "$0")/.."
mkdir -p ../deploy-logs
LOG="../deploy-logs/network-$CHAIN-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
echo "log: $(cd ../deploy-logs && pwd)/$(basename "$LOG")"

TV=~/.diamondz-tokenize-test-verifiers.env
TITLE=$(sed -n 's/^TEST_VERIFIER_TITLE_ADDRESS=//p' "$TV")
VAL=$(sed -n 's/^TEST_VERIFIER_VALUATION_ADDRESS=//p' "$TV")
INS=$(sed -n 's/^TEST_VERIFIER_INSURANCE_ADDRESS=//p' "$TV")
PAYOUT_RELAYER=$(sed -n 's/^PAYOUT_RELAYER_ADDRESS=//p' ~/.diamondz-tokenize.env)
TREX_RELAYER=$(sed -n 's/^TREX_RELAYER_ADDRESS=//p' ~/.diamondz-tokenize.env)
TREX_RELAYER_KEY=$(sed -n 's/^TREX_RELAYER_KEY=//p' ~/.diamondz-tokenize.env)
[ -n "$TREX_RELAYER" ] && [ -n "$TREX_RELAYER_KEY" ] || { echo "T-REX relayer missing in ~/.diamondz-tokenize.env" >&2; exit 1; }
set -a; . ~/.env; set +a
export PRIVATE_KEY="${PRIVATE_KEY:-${DEPLOYER_PK:-}}"
: "${PRIVATE_KEY:?no DEPLOYER_PK in ~/.env}"
# Short pause between steps: a fresh process reads its first nonce from the RPC, which can lag the last receipt.
o() { sleep 3; bun scripts/oracle.ts "$@" --chain "$CHAIN" --execute; }

bun scripts/oracle.ts whoami --chain "$CHAIN"

# Resume after a failed run: ORACLE=0x… reuses the oracle already deployed (every later step is safe to repeat).
if [ -n "${ORACLE:-}" ]; then echo "== reusing AssetOracle $ORACLE"; else
  out=$(o deploy | tee /dev/stderr)
  ORACLE=$(printf '%s' "$out" | sed -n 's/.*assetOracle: { address: "\(0x[0-9a-fA-F]\{40\}\)".*/\1/p')
fi
[ -n "$ORACLE" ] || { echo "oracle address not found in output" >&2; exit 1; }
echo "== no Chainlink CRE forwarder on chain $CHAIN: skipping CreAssetFeed"

o add-verifier --oracle "$ORACLE" --address "$TITLE" --name "TEST Title & Legal (testnet only)" --kinds TITLE,MINERAL_TITLE,IP_OWNERSHIP,CAP_TABLE,REGISTRY
o add-verifier --oracle "$ORACLE" --address "$VAL" --name "TEST Valuation & Audit (testnet only)" --kinds VALUATION,RESERVES,PRODUCTION,FINANCIALS,NAV,AUTHENTICITY
o add-verifier --oracle "$ORACLE" --address "$INS" --name "TEST Insurance & Custody (testnet only)" --kinds INSURANCE,CUSTODY,RENT_INCOME,ROYALTY_INCOME,LOAN_TAPE,SERVICING
for a in "$TITLE" "$VAL" "$INS"; do o fund --address "$a" --eth "$VER"; done

if [ "$CHAIN" = 1449000 ]; then
  # No Circle USDC on the XRPL EVM sidechain: one shared platform Test USD for practice purchases and payouts.
  tout=$(o deploy-testusd | tee /dev/stderr)
  TUSD=$(printf '%s' "$tout" | sed -n 's/.*stable: { address: "\(0x[0-9a-fA-F]\{40\}\)".*/\1/p')
  [ -n "$TUSD" ] || { echo "TestUSD address not found in output" >&2; exit 1; }
  o deploy-distributor --fee 0 --stable "$TUSD"
else
  o deploy-distributor --fee 0
fi
[ -n "$PAYOUT_RELAYER" ] && o fund --address "$PAYOUT_RELAYER" --eth "$PAYOUT"
o fund --address "$TREX_RELAYER" --eth "$TREX"

TREX_RELAYER_KEY="$TREX_RELAYER_KEY" bun scripts/trex.ts deploy-core --chain "$CHAIN" --execute
echo
echo "DONE on chain $CHAIN. Paste the addresses above into web/src/lib/chains.ts."
