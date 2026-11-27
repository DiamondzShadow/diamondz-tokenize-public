# Diamondz Tokenize

**Turn a real asset into an investable token, and prove it's real every day it's for sale.**

A building, an oil royalty, a film, a private-credit note: an issuer structures the offering, verifies investors,
deploys the token and sale from their own wallet, gets independent professionals to sign off on the asset, and pays
holders in USDC. Run it as your own platform under your own brand.

**Try it:** https://tokenize.diamondz.one: live on test networks (Base Sepolia, Arbitrum Sepolia, Robinhood Chain,
Arc, Avalanche Fuji, XRPL EVM, Stellar). The film series *ICE PRINCE* on the home page is a working demo listing
with its checks signed on chain.

---

## What makes it different

- **Sales stop when the proof does.** Every sale contract asks an on-chain proof-of-asset oracle before it mints.
  Title companies, appraisers, insurers and custodians sign their checks with an expiry date. When a check lapses or
  fails, new sales pause on their own. An issuer can never approve itself, and only the verifier who failed a check
  can clear it.
- **Signatures that hold up.** Verifiers and the issuer's securities lawyer sign real letters in **Adobe Acrobat
  Sign**, after a government-ID or phone check. The signed letter and Adobe's audit report are kept, and their
  fingerprint goes on chain with the check, so any investor can download both and confirm they match.
- **Income proven from the bank.** Rent and royalty checks can come straight from the SPV's bank account through
  Mastercard Open Finance or Stripe, signed on chain by a gasless relayer.
- **Live market data from Chainlink.** A Chainlink Runtime Environment workflow writes oil, metals, equity, inflation
  and rate data next to each listing every 30 minutes.
- **Every token standard from one wizard.** ERC-7943 (fungible, multi-token and NFT), ERC-4626 vaults and the audited
  ERC-3643 suite, all with the same compliance rules and proof gating. Stellar offerings run from the same console.
- **Investors keep their privacy.** Accreditation reports go straight from the investor to Mastercard; the platform
  stores references and a numbers-only summary, and the issuer decides.
- **Payouts that reach people.** Merkle distributions in USDC, gas-free claims, and automatic delivery after seven
  days.
- **Flat fees.** Monthly plan + setup + a flat fee per mainnet offering, paid on chain.
- **White-label from one codebase.** Each customer gets a guided setup: their own domain with a certificate issued
  automatically, email from their own address, their own legal pages, and their brand, asset menu and claim issuers.

## Try it in five minutes (no accounts needed)

You need [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh/getting-started/installation)
(`forge` + `anvil`).

```sh
git clone --recurse-submodules https://github.com/DiamondzShadow/diamondz-tokenize-public.git
cd diamondz-tokenize-public
(cd api && bun install) && (cd web && bun install)

cd contracts && forge test                    # 169 contract tests
cd ../web && bun scripts/e2e-proof.ts         # a whole offering on a local chain: deploy, verify, buy
bun scripts/e2e-esign.ts                      # Adobe signing flow against a stand-in Adobe server
```

Each `e2e-*` script starts its own local chain and a throwaway API with its own database, and cleans up after itself.

## Run your own copy

```sh
cp tokenize.env.example tokenize.env          # fill in what you need; tokenize.env stays on your machine
cd api && bun --env-file=../tokenize.env run src/server.ts     # API on :8911
cd web && bun run dev                         # site on :5173, talks to the API
```

The first start creates the platform tenant for the hosts in `DEFAULT_HOSTS`. Sign in to the console at `/app`.

### Services and what they unlock

Start with the first two rows. Add the others when you want the feature: each one switches on as soon as its
settings are present. `tokenize.env.example` explains every setting.

| Service | Unlocks | Settings | Get it at |
|---|---|---|---|
| **Google Identity** | Console sign-in for your team | `ADMIN_DOMAINS`, `GOOGLE_CLIENT_ID` | console.cloud.google.com › Credentials |
| **thirdweb** | Investor and self-serve issuer sign-in, wallets | `THIRDWEB_CLIENT_ID` | thirdweb.com |
| **Uniblock** | One RPC key for every EVM chain | `UNIBLOCK_API_KEY` | uniblock.dev |
| **Resend** | Lawyer links, one-time codes, contact alerts | `RESEND_API_KEY`, `NOTIFY_FROM` | resend.com |
| **Sumsub** or **Stripe Identity** | Investor identity checks | `SUMSUB_*` or `STRIPE_*` | sumsub.com · stripe.com |
| **Stripe** | Company verification for issuers, bank links | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | stripe.com |
| **Adobe Acrobat Sign** | Signed verifier checks and lawyer sign-off | `ADOBE_SIGN_INTEGRATION_KEY` | adobe.com/sign/developer-form.html |
| **Mastercard Open Finance** | Accreditation reports, bank-backed income checks | `MC_RELAY_URL`, `MC_RELAY_TOKEN` (deploy `mc-relay/`) | developer.mastercard.com |
| **MongoDB Atlas** | Shared database for several API servers | `STORE=mongo`, `MONGO_URI` | mongodb.com/atlas |
| **Temporal Cloud** | Scheduled jobs with retries and history | `TEMPORAL_JOBS=1` + `temporal/` worker | temporal.io |
| **Chainlink CRE** | Market data written next to listings | see `cre/README.md` | docs.chain.link/cre |
| **SEC EDGAR** | Attach the issuer's Form D | `SEC_EDGAR_UA` | free, no account |
| **Cloudflare for SaaS** | White-label customers on their own domain | `CF_API_TOKEN`, `CF_ZONE_ID` | dash.cloudflare.com › SSL/TLS › Custom Hostnames |

**Your own contracts.** Networks, contract addresses and oracles live in `web/src/lib/chains.ts`. To put the
proof-of-asset oracle on a test network with your own wallet:

```sh
cd web
PRIVATE_KEY=0x... bun scripts/oracle.ts deploy --chain 84532 --execute        # prints the line to paste into chains.ts
PRIVATE_KEY=0x... bun scripts/oracle.ts add-verifier --chain 84532 --address 0x... --name "Acme Title" --kinds TITLE --execute
```

Every admin script in `web/scripts/` only reads and prints until you add `--execute`.

## How it's built

| Folder | What's inside |
|---|---|
| `contracts/` | Foundry. Platform contracts (MIT, solc 0.8.28) and the audited ERC-3643 suite as pinned GPL-3.0 submodules (solc 0.8.17). |
| `api/` | Bun + Hono. Tenants resolved from the `Host` header. Proof of asset, payouts, e-signing, ERC-3643 relayer, accreditation, bank proof, background jobs. |
| `web/` | Vite + React. Marketing site, marketplace, investor pages, issuer console (`/app`), and the `e2e-*` test suites in `web/scripts/`. |
| `temporal/` | Temporal Cloud worker and schedules. |
| `mc-relay/` | US relay for Mastercard Open Finance (Cloud Run). |
| `cre/` | Chainlink Runtime Environment workflows for market data and Stellar attestations. |
| `stellar/` | Soroban contracts for Stellar offerings. |
| `design/` | HTML sources of the design frames. |

### Token standards

| Standard | Contracts | Good for |
|---|---|---|
| ERC-20 + **ERC-7943** | `PermissionedToken` + `PrimarySale` | Real estate, equity, credit |
| **ERC-4626** | `PermissionedVault` (NAV, deposit cap, proof gating) | Funds and yield |
| ERC-1155 + **ERC-7943** | `PermissionedMultiToken` + `PrimarySale1155` (fixed-cap items, carbon retirement) | Collectibles, carbon vintages |
| ERC-721 + **ERC-7943** | `PermissionedNFT` + `PrimarySale721` | Deeds, single items |
| **ERC-3643** (T-REX 4.1.6) | Audited suite via `TREXPlatform` + `PrimarySale3643` | Institutional securities |

ERC-7943 interface ids are asserted in tests against the Final spec: fungible `0x3edbb4c4`, multi-token `0x41c4fbad`,
non-fungible `0xbf1ef5fe`.

### How a signed check reaches the chain

1. The issuer picks a check (say, insurance) and a verifier firm the platform has approved.
2. The platform sends an attestation letter through Adobe Acrobat Sign; the signer proves who they are and signs.
3. Adobe notifies the API; the API re-reads the agreement from Adobe, downloads the signed letter and audit report,
   and stores both.
4. The API records the check on the offering's oracle with
   `evidenceHash = sha256({"letter": sha256(letter.pdf), "audit": sha256(audit.pdf)})`.
5. The listing shows who signed and how, with both PDFs; `/api/esign/<id>/evidence` lets anyone recompute the hash.

## Tests

```sh
cd contracts && forge test                    # 169 tests: tokens, sales, oracle, payouts, ERC-3643, IP registry
cd web && bun scripts/e2e-<name>.ts           # 31 end-to-end suites, e.g. proof, payouts, vault, 3643, esign,
                                              # counsel-adobe, legal, accredit, bank, rules, ip, stellar
cd api && bun scripts/store-contract.ts       # the same scenario on SQLite and MongoDB must give identical results
```

## Built with

Chainlink CRE and price feeds · Circle USDC and CCTP · Adobe Acrobat Sign · Mastercard Open Finance · Stripe ·
Sumsub · Tokeny T-REX + ONCHAINID · OpenZeppelin · Chainalysis sanctions oracle and the OFAC SDN list · thirdweb ·
Temporal · MongoDB Atlas · Google Cloud · viem · Foundry · Bun · Hono · React · Vite.
Names are trademarks of their owners; each entry describes how this code integrates the service.

## Legal

Diamondz Tokenize is software. Issuers make their own offerings under their own exemptions, with their own counsel;
mainnet use follows that sign-off. Diamondz is not a broker-dealer, exchange, transfer agent or investment adviser.
