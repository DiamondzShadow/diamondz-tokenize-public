# Diamondz Tokenize

> **Public source snapshot.** Secrets and API keys are kept out of this repo: they live in server-side env files and Chainlink Vault. Server-ops files (deploy configs, security runbooks) are kept in the private repo.

Multi-asset tokenization platform with multi-tenant white-label: issuers structure an offering, verify investors,
deploy the token and sale from their own wallet, prove the asset with independent checks, and pay holders.
Live on test networks at **https://tokenize.diamondz.one** (Base Sepolia, Arbitrum Sepolia, Robinhood Chain testnet).

> Software only. Not a broker-dealer, exchange, transfer agent or investment adviser. Offerings are made by issuers
> under their own exemptions; mainnet use waits on counsel.

## Layout

| Dir | What |
|---|---|
| `contracts/` | Foundry. Our contracts (MIT, solc **=0.8.28**) + the audited ERC-3643 suite as pinned GPL-3.0 submodules (solc 0.8.17, untouched). |
| `api/` | Bun + Hono. Tenant resolved from the `Host` header only. Console sign-in = Google Workspace. Proof of asset, payouts, ERC-3643 relayer, Mastercard accreditation + bank proof, background jobs. |
| `web/` | Vite + React. Marketing site, marketplace, investor pages and issuer console (`/app`). Branding from the tenant config. |
| `temporal/` | Temporal Cloud worker + schedules for background jobs. |
| `mc-relay/` | Mastercard Open Finance relay for Cloud Run (us-central1). |
| `cre/` | Chainlink Runtime Environment workflow for asset data feeds. |
| `design/` | HTML sources of the design frames. |

## Token standards

| Standard | Contracts | For |
|---|---|---|
| ERC-20 + **ERC-7943** (uRWA, fungible) | `PermissionedToken` + `PrimarySale` | Real estate, equity, credit |
| **ERC-4626** | `PermissionedVault` (NAV, deposit cap, proof gating) | Funds and yield |
| ERC-1155 + **ERC-7943** multi-token | `PermissionedMultiToken` + `PrimarySale1155` (fixed-cap items, carbon retirement) | Collectibles, carbon vintages |
| ERC-721 + **ERC-7943** non-fungible | `PermissionedNFT` + `PrimarySale721` | Deeds, single items |
| **ERC-3643** (T-REX 4.1.6) | Audited suite via `TREXPlatform` + `PrimarySale3643` | Institutional securities |

ERC-7943 interface ids are asserted in tests against the Final spec: fungible `0x3edbb4c4`, multi-token `0x41c4fbad`,
non-fungible `0xbf1ef5fe`.

## Third-party technology we use

We integrate the services below; we have **no partnership or endorsement** from these companies unless stated.
Names are trademarks of their respective owners.

| Technology | How we use it | Where | Status |
|---|---|---|---|
| **Chainlink Runtime Environment (CRE)** | A workflow reads market data (Chainlink WTI, SPY, gold/silver, PCE feeds with sequencer and staleness checks; NY Fed SOFR; Story royalty vaults; on-chain carbon registries) and writes marks and attestations to our `CreAssetFeed` receiver (Chainlink's official `ReceiverTemplate`), which signs NAV / registry checks into the proof-of-asset oracle. | `cre/asset-feeds`, `contracts/src/oracle/CreAssetFeed.sol` | Receivers deployed on Base Sepolia + Arbitrum Sepolia; `asset-feeds` and `stellar-feeds` workflows **deployed on CRE (private registry, every 30 minutes)** since 2026-11-26 |
| **Circle USDC** | Payment token for primary sales and the payout token for holder distributions (Base Sepolia, Arbitrum Sepolia; mainnet config for Base, Arbitrum, Polygon, Optimism, Avalanche, HyperEVM). | `web/src/lib/chains.ts` | Live on testnets |
| **Mastercard Open Finance US** | (1) **Accredited-investor checks**: the investor links accounts in Mastercard Data Connect and Mastercard prepares a Verification of Income / of Assets report (FCRA consent, purpose 1W) that the issuer reviews. Identity details pass through to Mastercard and are never stored. (2) **Bank-read proof of asset**: the SPV's account is linked, deposits are read monthly, and the platform signs the offering's rent/royalty check on chain. Calls go through our US relay because Open Finance only accepts US/UK/CA/AU IPs. Data Connect via Mastercard's `connect-web-sdk` (MIT). | `api/src/mastercard.ts`, `api/src/bankproof.ts`, `mc-relay/` | **Sandbox** (Mastercard test bank); production access needs a Mastercard agreement |
| **Tokeny T-REX 4.1.6 + ONCHAINID 2.2.1** (GPL-3.0) | The audited ERC-3643 suite, compiled untouched from pinned submodules. Our platform factory deploys each offering's suite and hands every contract to the issuer's wallet; issuers run their own claim issuer. GPL bytecode is used server-side only and never ships in the web bundle. | `contracts/lib/T-REX`, `contracts/lib/onchain-id`, `contracts/src/trex/TREXPlatform.sol`, `api/src/trex.ts` | Live on all 3 testnets |
| **OpenZeppelin Contracts** 5.4 (and 4.9.6 for T-REX) | AccessControl, ERC standards, SafeERC20, EIP-712, Merkle proofs. `@openzeppelin/merkle-tree` builds payout trees. | `contracts/`, `api/src/payouts.ts` | Live |
| **Chainalysis sanctions oracle** + **OFAC SDN list** (via 0xB10C's daily extract) | The investor registry refuses sanctioned wallets on chain where the oracle exists; every chain also screens against the OFAC list before verification or a KYC claim. Fails closed. | `contracts/src/compliance/InvestorRegistry.sol`, `api/src/server.ts` | Live |
| **thirdweb** | Investor sign-in and wallets (email, Google, passkey, injected wallets). | `web/src/lib/Connect.tsx` | Live |
| **Temporal Cloud** | Background jobs (proof refresh, accreditation polling, payout auto-delivery, monthly bank check, sanctions list reload) run as schedules with retries and history, once per schedule no matter how many API servers run. | `temporal/tokenize_temporal.py`, `api/src/jobs.ts` | Live |
| **MongoDB Atlas** | Production database (dedicated Flex cluster), so several API servers can serve white-label tenants from one source of truth. One storage interface with two backends: Atlas in production, single-file SQLite for local runs and tests; a contract test proves both return identical results. | `api/src/store.ts`, `api/scripts/` | Live |
| **Google Cloud** (Cloud Run, Secret Manager, IAM) | Hosts the Mastercard relay in us-central1, holds its credentials; only the platform VM's identity may call it. | `mc-relay/` | Live |
| **Google Identity** | Issuer console sign-in, restricted to the tenant's Google Workspace domains. | `api/src/server.ts` | Live |
| **viem**, **Foundry**, **Bun**, **Hono**, **React/Vite** | Chain access, contracts and tests, API runtime, web app. | everywhere | Live |

## What's different

- **Sales stop when the proof does.** Every primary sale reads an on-chain proof-of-asset oracle before minting.
  Platform-vetted independent verifiers (title, appraisal, insurance, custody, registries, data feeds) sign per-class
  checks with expiry; an issuer can never approve itself as a verifier; a failed check can only be cleared by the
  verifier that failed it (no verifier shopping); a lapsed or failed check pauses new sales automatically.
- **Income proven from the bank, not a PDF.** Rent and royalty checks can be signed from the SPV's bank account via
  Mastercard Open Finance, with gasless EIP-712 attestations submitted by a relayer. Transfers between the SPV's own
  accounts never count.
- **Accreditation without keeping personal data.** Investors' identity details go straight to Mastercard; we store
  only report references, the consent record and a numbers-only summary. The issuer always decides.
- **Issuer-controlled ERC-3643.** The platform deploys the audited suite but every contract (including the identity
  registry storage the factory normally keeps) belongs to the issuer. The platform files issuer-signed KYC claims but
  cannot forge one, can't mint, freeze or force-transfer, and, by default, can't upgrade the token's code.
- **All three ERC-7943 variants** (fungible, multi-token, NFT) plus ERC-4626 and ERC-3643 from one codebase and one
  wizard, with the same compliance model and proof-of-asset gating.
- **Flat fees, not a cut of the raise.** Pricing is monthly + setup + a flat fee per mainnet offering, paid on chain
  and verified once; no percentage of securities sales.
- **Payouts that reach holders.** Merkle distributions in USDC with gas-free claims and automatic delivery after
  seven days.
- **White-label from one codebase.** Tenants are resolved from the `Host` header only; branding, asset menu, KYC
  accounts and claim issuers are per tenant.

## Tests

```sh
cd contracts && forge test                  # 159 tests (incl. T-REX integration, offering rules, IP registry)
cd web && bun scripts/e2e-<name>.ts          # anvil + throwaway API end-to-end suites:
#   e2e-proof · e2e-payouts · e2e-vault · e2e-1155 · e2e-721 · e2e-3643 · e2e-accredit · e2e-bank · e2e-rules · e2e-ip
cd api && bun scripts/store-contract.ts      # same scenario on SQLite and on a throwaway Atlas DB; results must match
```

## Storage

`STORE=mongo` (production) uses MongoDB Atlas via `MONGO_URI` / `MONGO_DB`; otherwise the API uses SQLite at
`api/data/tokenize.db`. `bun scripts/migrate-to-mongo.ts` is read-only by default; `--execute` copies SQLite into an
**empty** Atlas database and verifies every row. Rollback: remove `STORE=mongo` and restart (the migration never
writes to the SQLite file). Quote `MONGO_URI` in the env file: it contains `&`.

## Run locally

```sh
cd api && ADMIN_DOMAINS=yourco.com GOOGLE_CLIENT_ID=... bun run src/server.ts   # :8911
cd web && bun run dev                        # proxies /api to :8911
```

First boot creates tenant `diamondz` on hosts `localhost,127.0.0.1,tokenize.diamondz.one` (override with
`DEFAULT_HOSTS`). Background jobs run on local timers unless `TEMPORAL_JOBS=1`. Secrets live only in
`~/.diamondz-tokenize.env` on the server (never in this repo).
