# Stellar for Diamondz Tokenize: scoping (2026-11-18)

Status (2026-11-19): **contracts built + LIVE on Stellar testnet** (`stellar/`, addresses in `stellar/deployments/testnet.json`;
`stellar/deploy-testnet.sh --execute` proves the gates on-chain). App integration not started. Chainlink can READ
Stellar but not write to it: compliance and writes stay in the Soroban contracts; Chainlink reads Stellar state.

Original status: scoping only. Prompted by Blockworks' "Stellar Token Holder Report Q3 2026"
(Stellar positions itself on tokenized RWAs).

## What exists off the shelf

- OpenZeppelin Stellar Contracts ships an **ERC-3643 / T-REX RWA token for Soroban** (added in v0.5.0, 2025-10-28;
  source `packages/tokens/src/rwa`). Same compliance model we already use on EVM (identity registry, compliance
  modules, agent roles), so tenant-facing concepts carry over 1:1.
- OpenZeppelin **RWA Wizard** generates those contracts for Stellar testnet (UI + CLI).
- The OpenZeppelin Stellar MCP tools are already connected in this environment (fungible, non-fungible, vault,
  stablecoin, governor, account), so contract generation is quick.

## Why it is NOT a config change for us

Tokenize is EVM-only end to end:

| Layer | Today | Stellar needs |
|---|---|---|
| Contracts | Solidity (Foundry), ERC-3643 4.x / ERC-7943 / 1155 / 721 | Rust → WASM (Soroban), separate test suite |
| Chain registry | `web/src/lib/chains.ts`, numeric `chainId`, `0x` addresses | non-numeric network id, `G…`/`C…` addresses |
| API reads | viem (`api/src/*.ts`) | Stellar RPC / Horizon client |
| Wallets | thirdweb / injected EVM | Freighter / Stellar Wallets Kit |
| Prices (AssetOracle) | Chainlink CRE → KeystoneForwarder (EVM) | **unverified** whether CRE can write to Soroban; Chainlink Data Feeds availability on Stellar must be checked |
| KYC / accreditation | Sumsub + Mastercard → on-chain identity claims | same off-chain flow, new on-chain claim writer |

The oracle row is the real blocker: our pitch is "Chainlink-priced". If CRE can't deliver to Soroban, a Stellar
tenant would get a different price source than the other chains.

## Suggested path (smallest useful step first)

1. **Ask Chainlink** (we have an MNDA + open CRE thread): is Soroban a CRE write target, and are Data Feeds live on Stellar?
2. Generate a T-REX token with the RWA Wizard on **Stellar testnet** and walk one issuance + transfer-gate by hand.
3. Only if 1 is yes: add a `stellar` network kind to `chains.ts` behind a feature flag, read-only (show balances/holders),
   then issuance.

Effort guess if Chainlink says yes: contracts ~days (generated), app integration is the bulk (wallet + address model).

## Sources
- https://docs.openzeppelin.com/stellar-contracts/changelog
- https://docs.openzeppelin.com/stellar-contracts/tokens/rwa/rwa
- https://openzeppelin.com/news/rwa-wizard-issue-regulated-real-world-assets-on-stellar
- https://developers.stellar.org/docs/tools/openzeppelin-contracts
