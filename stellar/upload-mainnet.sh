#!/usr/bin/env bash
# Upload the Stellar edition's contract code to Stellar MAINNET (one time, ~312 XLM, paid by the mainnet relayer).
#   stellar/upload-mainnet.sh             # dry run: shows what would be uploaded and the relayer's balance
#   stellar/upload-mainnet.sh --execute   # uploads, writes deployments/mainnet-wasm.json, prints the chains.ts block
# RPC: Uniblock (UNIBLOCK_API_KEY from ~/.diamondz-tokenize.env). Signer: stellar CLI identity tz-relayer-mainnet.
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-}"
KEY="$(grep -E '^UNIBLOCK_API_KEY=' "$HOME/.diamondz-tokenize.env" | head -n1 | cut -d= -f2- | tr -d '"'"'"' \r')"
[ -n "$KEY" ] || { echo "UNIBLOCK_API_KEY missing in ~/.diamondz-tokenize.env"; exit 1; }
RPC="https://api.uniblock.dev/uni/v1/json-rpc?chainId=stellar-soroban&apiKey=$KEY"
PASSPHRASE="Public Global Stellar Network ; September 2015"
W=target/wasm32v1-none/release
OUT=deployments/mainnet-wasm.json
RELAYER="$(stellar keys address tz-relayer-mainnet)"
# key in chains.ts → wasm file
MAP="cti:rwa_claim_topics_and_issuers_example claimIssuer:rwa_claim_issuer_example identity:rwa_identity_example registry:rwa_identity_registry_example verifier:rwa_identity_verifier_example compliance:rwa_compliance_example token:rwa_token_example supplyLimit:compliance_supply_limit maxBalance:compliance_max_balance countryAllow:compliance_country_allow countryRestrict:compliance_country_restrict lockup:compliance_initial_lockup_period sale:diamondz_stellar_sale"

stellar contract build >/dev/null
for kv in $MAP; do f="${kv#*:}"; [ -f "$W/$f.wasm" ] || { echo "missing $W/$f.wasm"; exit 1; }; done
BAL="$(curl -s -m 20 "https://horizon.stellar.org/accounts/$RELAYER" | python3 -c 'import json,sys
d=json.load(sys.stdin); print(next((b["balance"] for b in d.get("balances",[]) if b["asset_type"]=="native"), "0"))')"
echo "relayer $RELAYER  balance ${BAL} XLM (needs ~320 for the upload)"
if [ "$MODE" != "--execute" ]; then
  for kv in $MAP; do echo "  would upload ${kv#*:}.wasm  ($(stat -c %s "$W/${kv#*:}.wasm") bytes)"; done
  echo "dry run: nothing sent. Re-run with --execute."
  exit 0
fi
python3 -c "import sys; sys.exit(0 if float('$BAL') >= 320 else 1)" || { echo "relayer balance too low"; exit 1; }
echo "{" > "$OUT"; first=1
for kv in $MAP; do
  k="${kv%%:*}"; f="${kv#*:}"
  h="$(stellar contract upload --rpc-url "$RPC" --network-passphrase "$PASSPHRASE" --source tz-relayer-mainnet --wasm "$W/$f.wasm" 2>/dev/null | tail -n1)"
  [[ "$h" =~ ^[0-9a-f]{64}$ ]] || { echo "upload of $f failed"; exit 1; }
  [ $first = 1 ] || echo "," >> "$OUT"; first=0
  printf '  "%s": "%s"' "$k" "$h" >> "$OUT"; echo "  ✓ $k $h"
done
echo; echo "}" >> "$OUT"
echo "wrote $OUT — paste into the mainnet entry's wasm in web/src/lib/chains.ts"
