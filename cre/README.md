# Chainlink CRE workflows

Two workflows run on the Chainlink Runtime Environment (CRE). Every 30 minutes (at :00 and :30 UTC), a group of
Chainlink nodes runs each one, agrees on the result and writes it to our `CreAssetFeed` receiver contract. Sale
contracts read the proof-of-asset oracle before they mint, so stale data or a failed check stops new sales.

| Workflow | What it does | Writes to |
|---|---|---|
| `asset-feeds` | Reads Chainlink price feeds (WTI crude, SPY, gold, silver, PCE inflation), NY Fed SOFR, Story royalty vaults and on-chain carbon registries; writes per-token **marks** (prices) and signs NAV / registry **attestations** into the oracle. | `CreAssetFeed` on Base Sepolia |
| `stellar-feeds` | Discovers Stellar offerings from `GET https://tokenize.diamondz.one/api/stellar/cre-targets`, reads supply and compliance settings from Stellar, and attests that each offering is valid. | `CreAssetFeed` on Base Sepolia |

## Deployments

Both live on the CRE **private registry** (no onchain transaction, no wallet key). DON family `zone-a`.
Workflow owner (assigned by CRE): `0x99c516870b1532d6A0d8a078653755d5C6e48362`.

| Name | Workflow ID | Deployed |
|---|---|---|
| `asset-feeds-staging` | `00c191142adc8b31378281cba652829e14089175e49b0744b6021ac630ca2993` | 2026-11-26 |
| `stellar-feeds-staging` | `001e598ecee78c65e77136a12787cd35860f57c94926665ebcb90b666855bebf` | 2026-11-26 |

Receiver: `0x3F4396417f142fD406215E8437C448Cb28bf7552` (Base Sepolia, `writeChain` in `config.staging.json`).

## Status (2026-11-26, evening)

- `asset-feeds`: tracks the two **demo** listings on Base Sepolia — Blanket (energy: WTI + estimated royalty from a demo
  120 bbl/day at 12.5%) and drama (New York real estate: PCE + a demo $100M appraisal carried forward by FRED `NYSTHPI`).
  FRED is read keyless from the public CSV (`keyed.fred: false`). Massive (REIT index, comps) stays off until its key is
  in the CRE vault (`keyed.massive: false`).
- `stellar-feeds`: uses the public Stellar RPCs (`uniblock: false`) because the vault secret upload (login.chain.link
  browser sign-in) errors. Switch back to `uniblock: true` once `UNIBLOCK_API_KEY_SECRET` is uploaded.
- `CreAssetFeed` is not yet locked to the workflow owner (`setExpectedAuthor`). Two workflows write to it, so lock by
  author, not workflow ID.
- The public `/markets` page (api `GET /api/markets`) shows the same Chainlink feeds live, one-year charts (FRED +
  Massive, key `MASSIVE_API_KEY` in the VM env) and house prices for every state.

## Market data per asset class

Shown in each listing's proof panel (`web/src/lib/Proof.tsx`, metrics from `CLASS_FEEDS` in
`web/src/lib/verification.ts`). Values are numbers with a timestamp; there are no charts.

| Class | Metrics |
|---|---|
| Real estate | HPI-adjusted value, REIT index (VNQ), US inflation (PCE, Chainlink) |
| Energy | WTI crude (Chainlink), estimated monthly royalty |
| Private equity | Public market (SPY, Chainlink) |
| Private credit | SOFR, current floating rate |
| Funds | NAV per share (Chainlink NAVLink, issuer-sponsored) |
| Collectibles | Gold, silver (Chainlink), metal holding value |
| Carbon | Credits held on chain |
| Music IP, film, sports | Attestations only (no market metric) |

To track a listing, add an entry to `assets` in `asset-feeds/config.staging.json` (shape: the `asset` schema at the
top of `asset-feeds/main.ts`, max 40), simulate, then redeploy.

## Adding API keys to the Chainlink vault

Step-by-step, copy-paste guide for the owner: [`vault-setup/README.md`](vault-setup/README.md).

## Commands

Run from this folder. `.env` holds `UNIBLOCK_KEY_VAR`; its `CRE_ETH_PRIVATE_KEY` is a placeholder, so commands that
need a key must use `-e <env file with only the needed vars>`.

```bash
cre whoami                                   # account + Deploy Access
cre workflow list
cre execution list <workflow-name>           # add --status FAILURE
cre execution events <execution-id>          # shows errors

# simulate (asset-feeds wants the FRED/Massive vars present; any value works when no real-estate asset is listed)
FRED_KEY_VAR=unset MASSIVE_KEY_VAR=unset cre workflow simulate asset-feeds --target staging-settings --non-interactive --trigger-index 0
cre workflow simulate stellar-feeds --target staging-settings --non-interactive --trigger-index 0

# deploy / redeploy
cre workflow deploy asset-feeds --target staging-settings --non-interactive --yes
cre workflow deploy stellar-feeds --target staging-settings --non-interactive --yes

# vault secret (opens a login.chain.link sign-in; the link expires in about a minute)
cre secrets create stellar-feeds/secrets.yaml --target staging-settings --secrets-auth browser --non-interactive --yes -e <env>
```

The CLI's sign-in callback listens on `127.0.0.1:53682` on the VM. After signing in, paste the browser's
`http://127.0.0.1:53682/callback?...` address back to whoever runs the command so it can be forwarded to the VM.
