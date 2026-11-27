#!/usr/bin/env bash
# Diamondz Tokenize — Stellar (Soroban) edition: deploy the full ERC-3643-style stack to Stellar TESTNET and prove the
# compliance gates on-chain. Contracts: OpenZeppelin Stellar Contracts v0.8.0 RWA examples (contracts/).
#
#   ./deploy-testnet.sh             # print the plan only (default, sends nothing)
#   ./deploy-testnet.sh --execute   # deploy + configure + run the checks on testnet
#
# Testnet only: keys are fresh `stellar keys` identities funded by friendbot (tz-admin, tz-alice, tz-bob, tz-carol).
# The claim-signing Ed25519 key is generated once into ~/.diamondz-tokenize-stellar-claim.key (600) — NOT the
# public all-zero key from the OZ guide. Output: deployments/testnet.json.
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-}"
NET=testnet
W=target/wasm32v1-none/release
SIGN=contracts/sign-claim/target/release/rwa-sign-claim
OUT=deployments/testnet.json
KEYFILE="$HOME/.diamondz-tokenize-stellar-claim.key"
LOCKUP_LEDGERS=6          # ~30s, so the lockup check can be shown failing then passing
US=840; KP=408            # ISO 3166-1 numeric: United States allowed, North Korea restricted
D=10000000                # 7 decimals

plan() {
  cat <<EOF
Plan (Stellar $NET):
  keys      tz-admin tz-alice tz-bob tz-carol (friendbot-funded; carol is never verified)
  identity  claim-topics-and-issuers (KYC=1, AML=2) · claim-issuer (own Ed25519 key) · identity per investor
            · identity-registry (alice, bob = US/$US) · identity-verifier
  token     compliance + "Diamondz Test Property" (DZTP, 7 dec), bound to registry + compliance
  modules   supply-limit 1,000,000 · max-balance 500/identity · country-allow $US · country-restrict $KP
            · initial-lockup $LOCKUP_LEDGERS ledgers
  checks    mint 100 → alice; alice→carol (unverified) MUST fail; alice→bob during lockup MUST fail;
            after lockup alice→bob 10 MUST pass; mint 600 → bob MUST fail (max balance);
            frozen alice MUST NOT send; unfreeze
EOF
}

if [ "$MODE" != "--execute" ]; then plan; echo; echo "read-only: pass --execute to deploy"; exit 0; fi
[ -f "$W/rwa_token_example.wasm" ] || { echo "build first: stellar contract build"; exit 1; }
[ -x "$SIGN" ] || cargo build -q --release --manifest-path contracts/sign-claim/Cargo.toml
plan; echo

stellar network use $NET >/dev/null
for k in tz-admin tz-alice tz-bob tz-carol; do
  stellar keys address $k >/dev/null 2>&1 || stellar keys generate $k --network $NET --fund >/dev/null
done
ADMIN=$(stellar keys address tz-admin)
if [ ! -s "$KEYFILE" ]; then (umask 077; openssl rand -hex 32 > "$KEYFILE"); fi
CLAIM_SK=$(tr -d '\n' < "$KEYFILE")

deploy() { # alias wasm [-- ctor args...]
  local alias=$1 wasm=$2; shift 2
  stellar contract deploy --network $NET --source tz-admin --alias "$alias" --wasm "$W/$wasm" "$@" 2>/dev/null | tail -n1
}
inv() { stellar contract invoke --network $NET "$@" 2>/dev/null; }
adm() { local id=$1; shift; inv --id "$id" --source tz-admin -- "$@"; }
expect_fail() { # label cmd...
  if "${@:2}" >/dev/null 2>&1; then echo "  ✗ $1 — went through, expected rejection"; BAD=1; else echo "  ✓ $1 — rejected"; fi
}
BAD=0

echo "== identity layer"
CTI=$(deploy tz-cti rwa_claim_topics_and_issuers_example.wasm -- --admin tz-admin --manager tz-admin)
adm $CTI add_claim_topic --claim_topic 1 --operator tz-admin >/dev/null
adm $CTI add_claim_topic --claim_topic 2 --operator tz-admin >/dev/null
ISSUER=$(deploy tz-claim-issuer rwa_claim_issuer_example.wasm -- --owner tz-admin)
adm $CTI add_trusted_issuer --trusted_issuer $ISSUER --claim_topics '[1, 2]' --operator tz-admin >/dev/null
REG=$(deploy tz-identity-registry rwa_identity_registry_example.wasm -- --admin tz-admin --manager tz-admin)
PROFILE='[{"map": [{"key": {"symbol": "country"}, "val": {"vec": [{"symbol": "Individual"}, {"vec": [{"symbol": "Residence"}, {"u32": '$US'}]}]}}, {"key": {"symbol": "metadata"}, "val": "void"}]}]'

PUB=""
declare -A IDS
for who in alice bob; do
  ID=$(stellar contract deploy --network $NET --source tz-$who --alias tz-identity-$who --wasm "$W/rwa_identity_example.wasm" -- --owner tz-$who 2>/dev/null | tail -n1)
  IDS[$who]=$ID
  for topic in 1 2; do
    out=$("$SIGN" --secret-key "$CLAIM_SK" --claim-issuer "$ISSUER" --identity "$ID" --claim-topic $topic --network testnet)
    data=$(awk '/^--data/{print $2}' <<<"$out"); sig=$(awk '/^--signature/{print $2}' <<<"$out"); PUB=$(awk '/^--public-key/{print $2}' <<<"$out")
    if [ "$who" = alice ]; then adm $ISSUER allow_key --public_key "$PUB" --registry $CTI --claim_topic $topic >/dev/null; fi
    inv --id $ID --source tz-$who -- add_claim --topic $topic --scheme 101 --issuer $ISSUER --signature "$sig" --data "$data" \
      --uri "https://tokenize.diamondz.one/claims/testnet/$who/$topic" >/dev/null
  done
  adm $REG add_identity --account tz-$who --identity $ID --initial_profiles "$PROFILE" --operator tz-admin >/dev/null
  echo "  $who verified (KYC+AML, US) identity=$ID"
done
VER=$(deploy tz-identity-verifier rwa_identity_verifier_example.wasm -- --admin tz-admin --manager tz-admin \
  --identity_registry_storage $REG --claim_topics_and_issuers $CTI)

echo "== token"
COMP=$(deploy tz-compliance rwa_compliance_example.wasm -- --admin tz-admin --manager tz-admin)
TOKEN=$(deploy tz-dztp rwa_token_example.wasm -- --name "Diamondz Test Property" --symbol DZTP \
  --admin tz-admin --manager tz-admin --compliance $COMP --identity_verifier $VER)
adm $REG bind_token --token $TOKEN --operator tz-admin >/dev/null
adm $COMP bind_token --token $TOKEN --operator tz-admin >/dev/null
echo "  DZTP $TOKEN"

echo "== compliance modules (configured before they are hooked)"
declare -A MOD
mod() { # alias wasm needs_irs hooks...
  local a=$1 w=$2 irs=$3; shift 3
  local m; m=$(deploy tz-$a $w -- --admin tz-admin --manager tz-admin)
  adm $m set_compliance_address --token $TOKEN --compliance $COMP --operator tz-admin >/dev/null
  [ "$irs" = 1 ] && adm $m set_identity_registry_storage --token $TOKEN --irs $REG --operator tz-admin >/dev/null
  MOD[$a]=$m; HOOKS[$a]="$*"
}
declare -A HOOKS
mod supply-limit compliance_supply_limit.wasm 0 Created Destroyed
adm ${MOD[supply-limit]} set_supply_limit --token $TOKEN --limit $((1000000*D)) --operator tz-admin >/dev/null
mod max-balance compliance_max_balance.wasm 1 Transferred Created Destroyed
adm ${MOD[max-balance]} set_max_balance --token $TOKEN --max $((500*D)) --operator tz-admin >/dev/null
mod country-allow compliance_country_allow.wasm 1 Transferred Created
adm ${MOD[country-allow]} add_allowed_country --token $TOKEN --country $US --operator tz-admin >/dev/null
mod country-restrict compliance_country_restrict.wasm 1 Transferred Created
adm ${MOD[country-restrict]} add_country_restriction --token $TOKEN --country $KP --operator tz-admin >/dev/null
mod lockup compliance_initial_lockup_period.wasm 0 Transferred Created Destroyed
adm ${MOD[lockup]} set_lockup_period --token $TOKEN --period $LOCKUP_LEDGERS --operator tz-admin >/dev/null
for a in "${!MOD[@]}"; do
  for h in ${HOOKS[$a]}; do adm $COMP add_module_to --hook $h --module ${MOD[$a]} --operator tz-admin >/dev/null; done
  echo "  $a ${MOD[$a]} on: ${HOOKS[$a]}"
done

echo "== checks"
adm $TOKEN mint --to tz-alice --amount $((100*D)) --operator tz-admin >/dev/null && echo "  ✓ minted 100 DZTP to alice"
expect_fail "alice → carol (no identity)" inv --id $TOKEN --source tz-alice -- transfer --from tz-alice --to tz-carol --amount $((10*D))
expect_fail "alice → bob during lockup" inv --id $TOKEN --source tz-alice -- transfer --from tz-alice --to tz-bob --amount $((10*D))
echo "  … waiting for the $LOCKUP_LEDGERS-ledger lockup"; sleep $((LOCKUP_LEDGERS*5+15))
if inv --id $TOKEN --source tz-alice -- transfer --from tz-alice --to tz-bob --amount $((10*D)) >/dev/null; then
  echo "  ✓ alice → bob 10 after lockup — passed"; else echo "  ✗ alice → bob after lockup — rejected"; BAD=1; fi
expect_fail "mint 600 → bob (max balance 500)" adm $TOKEN mint --to tz-bob --amount $((600*D)) --operator tz-admin
adm $TOKEN set_address_frozen --user_address tz-alice --freeze true --operator tz-admin >/dev/null
expect_fail "frozen alice → bob" inv --id $TOKEN --source tz-alice -- transfer --from tz-alice --to tz-bob --amount $((1*D))
adm $TOKEN set_address_frozen --user_address tz-alice --freeze false --operator tz-admin >/dev/null
BA=$(inv --id $TOKEN --source tz-admin -- balance --account tz-alice | tr -d '"'); BB=$(inv --id $TOKEN --source tz-admin -- balance --account tz-bob | tr -d '"')
echo "  balances: alice=$((BA/D)) bob=$((BB/D)) DZTP"

mkdir -p deployments
python3 - "$OUT" <<PY
import json,sys,datetime
json.dump({
  "network":"testnet","deployedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"admin":"$ADMIN",
  "token":{"address":"$TOKEN","name":"Diamondz Test Property","symbol":"DZTP","decimals":7},
  "compliance":"$COMP","identityVerifier":"$VER","identityRegistry":"$REG","claimTopicsAndIssuers":"$CTI",
  "claimIssuer":"$ISSUER","claimSigningPublicKey":"$PUB",
  "identities":{"alice":"${IDS[alice]}","bob":"${IDS[bob]}"},
  "modules":{$(for a in "${!MOD[@]}"; do printf '"%s":"%s",' "$a" "${MOD[$a]}"; done | sed 's/,$//')},
  "checksPassed": $([ $BAD = 0 ] && echo True || echo False)
}, open(sys.argv[1],"w"), indent=2)
PY
echo "wrote $OUT"; [ $BAD = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
