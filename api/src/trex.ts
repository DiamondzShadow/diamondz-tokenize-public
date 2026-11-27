// ERC-3643 (T-REX 4.1.6 / OnchainID 2.2.1) on the platform: everything the platform's T-REX relayer signs.
//
// Owner decisions (2026-11-18):
//   - The PLATFORM deploys each offering's suite through its own audited TREXFactory (deployTREXSuite is owner-only).
//     The whole suite is handed to the issuer's wallet, including the identity-registry storage the factory keeps.
//   - Upgrades: per offering. Default = the issuer takes its own implementation authority (one wallet transaction,
//     done in the console); not doing so leaves it on the platform's shared reference authority (opt-in).
//   - KYC: each issuer runs its OWN claim issuer (its wallet is the only key). The issuer's wallet signs a claim;
//     the platform only files it on the investor's identity and registers the wallet. The investor identity rejects
//     any claim the issuer's key didn't sign, so the platform can't make anyone verified on its own.
//
// Endpoints (issuer console, admin session):
//   POST /api/assets/:id/trex/prepare   { wallet }                  claim issuer (once per chain+wallet) + suite
//   POST /api/assets/:id/trex/identity  { wallet }                  investor ONCHAINID + the digest the issuer signs
//   POST /api/assets/:id/trex/kyc       { wallet, signature, country, accredited? }   file the issuer-signed claim(s)
//
// Offering rules (wizard step 5): accredited-only = a second required claim topic (ACCREDITED_TOPIC) that the
// issuer's claim issuer is trusted for; everything else goes through OfferingRulesModule (contracts/src/trex), one
// instance per chain, whose settings the factory applies while deploying the suite.
//
// The relayer key (TREX_RELAYER_KEY) owns the factory, the reference authority and the identity factory on testnets.
// Mainnet stays closed until those move to a Safe (owner decision pending).
import type { Hono } from "hono";
import {
  createPublicClient, createWalletClient, encodeAbiParameters, getAddress, http, isAddress, keccak256, toHex,
  nonceManager, type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import trexArtifacts from "./contracts/trex-artifacts.json";
import { networkById, trexFor, type Network, rpcUrl } from "./chains";
import { Rules, hasRules, moduleSettings } from "./rules";

const T = trexArtifacts as unknown as Record<string, { abi: Abi; bytecode: Hex }>;
export const KYC_TOPIC = 1n;
/** Platform-defined claim topic: "accredited investor", signed by the offering's own claim issuer. */
export const ACCREDITED_TOPIC = 2n;
const CLAIM_SCHEME_ECDSA = 1n;
export const TREX_VERSION = { major: 4, minor: 1, patch: 6 } as const;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// ------------------------------------------------------------------ clients
export function chainOf(net: Network) {
  const rpc = rpcUrl(net);
  return { id: net.id, name: net.name, nativeCurrency: net.native, rpcUrls: { default: { http: [rpc] } } } as const;
}
export function publicFor(net: Network): PublicClient {
  const chain = chainOf(net);
  return createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 30_000, retryCount: 2 }) }) as PublicClient;
}
export function walletFor(net: Network, key: string): WalletClient {
  const chain = chainOf(net);
  // Local nonce tracking: load-balanced public RPCs can answer eth_getTransactionCount from a lagging node and
  // hand back a nonce that was just used ("nonce too low"), which broke the first Base Sepolia core deploy.
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex, { nonceManager });
  return createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 60_000 }) });
}
function relayerFor(net: Network): WalletClient | null {
  const k = process.env.TREX_RELAYER_KEY;
  return k ? walletFor(net, k) : null;
}

/** One relayer transaction at a time per chain (nonces). */
const queues = new Map<number, Promise<unknown>>();
function serial<T>(chainId: number, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(chainId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  queues.set(chainId, next);
  return next;
}

type Log = (msg: string) => void;
async function deployArtifact(wc: WalletClient, pc: PublicClient, name: string, args: unknown[], log: Log) {
  const hash = await wc.deployContract({ abi: T[name].abi, bytecode: T[name].bytecode, args, account: wc.account!, chain: wc.chain });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${name} failed: ${hash}`);
  log(`✓ ${name} ${r.contractAddress}  ${hash}`);
  return { address: getAddress(r.contractAddress), block: Number(r.blockNumber), hash };
}
async function call(wc: WalletClient, pc: PublicClient, address: Address, name: string, fn: string, args: unknown[], log: Log, why: string) {
  const { request } = await pc.simulateContract({ address, abi: T[name].abi, functionName: fn, args, account: wc.account! });
  const hash = await wc.writeContract(request as any);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${why} failed: ${hash}`);
  log(`  ✓ ${why}  ${hash}`);
  return hash;
}
const read = <R,>(pc: PublicClient, address: Address, name: string, fn: string, args: unknown[] = []) =>
  pc.readContract({ address, abi: T[name].abi, functionName: fn, args }) as Promise<R>;

// ------------------------------------------------------------------ per-chain core (admin script)
/** Same contracts and order as contracts/src/trex/TREXPlatform.sol (tested in forge), one transaction each. */
export async function deployCore(wc: WalletClient, pc: PublicClient, log: Log = console.log) {
  const me = wc.account!.address;
  const idImpl = await deployArtifact(wc, pc, "Identity", [me, true], log);
  const idIA = await deployArtifact(wc, pc, "ImplementationAuthority", [idImpl.address], log);
  const idFactory = await deployArtifact(wc, pc, "IdFactory", [idIA.address], log);
  const impls = {
    tokenImplementation: (await deployArtifact(wc, pc, "Token", [], log)).address,
    ctrImplementation: (await deployArtifact(wc, pc, "ClaimTopicsRegistry", [], log)).address,
    irImplementation: (await deployArtifact(wc, pc, "IdentityRegistry", [], log)).address,
    irsImplementation: (await deployArtifact(wc, pc, "IdentityRegistryStorage", [], log)).address,
    tirImplementation: (await deployArtifact(wc, pc, "TrustedIssuersRegistry", [], log)).address,
    mcImplementation: (await deployArtifact(wc, pc, "ModularCompliance", [], log)).address,
  };
  const ia = await deployArtifact(wc, pc, "TREXImplementationAuthority", [true, ZERO, ZERO], log);
  await call(wc, pc, ia.address, "TREXImplementationAuthority", "addAndUseTREXVersion", [TREX_VERSION, impls], log, "register T-REX 4.1.6 implementations");
  const factory = await deployArtifact(wc, pc, "TREXFactory", [ia.address, idFactory.address], log);
  await call(wc, pc, ia.address, "TREXImplementationAuthority", "setTREXFactory", [factory.address], log, "point the authority at the factory");
  const iaFactory = await deployArtifact(wc, pc, "IAFactory", [factory.address], log);
  await call(wc, pc, ia.address, "TREXImplementationAuthority", "setIAFactory", [iaFactory.address], log, "enable per-offering authorities");
  await call(wc, pc, idFactory.address, "IdFactory", "addTokenFactory", [factory.address], log, "let the factory create token identities");
  return { trexFactory: factory.address, implementationAuthority: ia.address, iaFactory: iaFactory.address, idFactory: idFactory.address, fromBlock: idImpl.block };
}

// ------------------------------------------------------------------ offering-rules module (one per chain)
const rulesModules = new Map<number, Address>();
/** Configured module (TREX_RULES_MODULE_<chainId>, else the network config), else one this server deployed. */
export function rulesModuleFor(net: Network | undefined): Address | undefined {
  if (!net) return undefined;
  const env = process.env[`TREX_RULES_MODULE_${net.id}`];
  return (env as Address | undefined) ?? (net.trex as any)?.rulesModule ?? rulesModules.get(net.id);
}
/** Deploys the module on first use. Each offering records the module it was deployed with (asset.trex.rulesModule),
 *  so a second server deploying its own copy is harmless. Add the address to chains.ts to pin it. */
export async function ensureRulesModule(wc: WalletClient, pc: PublicClient, net: Network, log: Log = console.log) {
  const have = rulesModuleFor(net);
  if (have) return have;
  const d = await deployArtifact(wc, pc, "OfferingRulesModule", [], log);
  rulesModules.set(net.id, d.address);
  log(`[trex] OfferingRulesModule on ${net.name}: ${d.address} (pin it: TREX_RULES_MODULE_${net.id} or chains.ts trex.rulesModule)`);
  return d.address;
}

// ------------------------------------------------------------------ per offering
export type TrexCore = NonNullable<Network["trex"]>;

/** Deploys an issuer's claim issuer; `issuerKey` (their wallet) is its only key. */
export async function deployClaimIssuer(wc: WalletClient, pc: PublicClient, issuerKey: Address, log: Log = () => {}) {
  return (await deployArtifact(wc, pc, "ClaimIssuer", [issuerKey], log)).address;
}

/** deployTREXSuite (owner = the issuer's wallet) + hand the identity-registry storage to the issuer as well.
 *  Idempotent per salt. The platform relayer is an identity-registry agent so it can register KYC'd wallets; it is
 *  never a token agent (can't mint, freeze or force-transfer). */
export async function deploySuite(
  wc: WalletClient, pc: PublicClient, core: TrexCore,
  p: {
    salt: string; owner: Address; name: string; symbol: string; claimIssuer: Address;
    /** Offering rules: modules + their setting calls, and whether accreditation is a required claim. */
    accreditedOnly?: boolean; module?: Address; settings?: Hex[];
  },
  log: Log = () => {},
) {
  let token = await read<Address>(pc, core.trexFactory, "TREXFactory", "getToken", [p.salt]);
  let deployBlock: number | null = null;
  if (token === ZERO) {
    const topics = p.accreditedOnly ? [KYC_TOPIC, ACCREDITED_TOPIC] : [KYC_TOPIC];
    // The factory binds a module once and applies setting i through module i, so list the module once per call.
    const settings = p.module ? (p.settings?.length ? p.settings : []) : [];
    const modules = p.module ? (settings.length ? settings.map(() => p.module!) : [p.module]) : [];
    const h = await call(wc, pc, core.trexFactory, "TREXFactory", "deployTREXSuite", [
      p.salt,
      {
        owner: p.owner, name: p.name, symbol: p.symbol, decimals: 18, irs: ZERO, ONCHAINID: ZERO,
        irAgents: [p.owner, wc.account!.address], tokenAgents: [p.owner], complianceModules: modules, complianceSettings: settings,
      },
      { claimTopics: topics, issuers: [p.claimIssuer], issuerClaims: [topics] },
    ], log, `deploy ERC-3643 suite ${p.symbol}`);
    deployBlock = Number((await pc.getTransactionReceipt({ hash: h })).blockNumber);
    token = await read<Address>(pc, core.trexFactory, "TREXFactory", "getToken", [p.salt]);
  }
  const ir = await read<Address>(pc, token, "Token", "identityRegistry");
  const irs = await read<Address>(pc, ir, "IdentityRegistry", "identityStorage");
  const irsOwner = await read<Address>(pc, irs, "IdentityRegistryStorage", "owner");
  if (irsOwner.toLowerCase() === core.trexFactory.toLowerCase()) {
    await call(wc, pc, core.trexFactory, "TREXFactory", "recoverContractOwnership", [irs, p.owner], log, "hand the identity storage to the issuer");
  }
  return { token: getAddress(token), identityRegistry: getAddress(ir), identityStorage: getAddress(irs), deployBlock };
}

/** The investor's ONCHAINID on this chain (shared across offerings), created by the platform if missing. The platform
 *  is its management key so it can file issuer-signed claims; it can't sign claims that pass any claim issuer. */
export async function ensureIdentity(wc: WalletClient, pc: PublicClient, core: TrexCore, wallet: Address, log: Log = () => {}) {
  let id = await read<Address>(pc, core.idFactory, "IdFactory", "getIdentity", [wallet]);
  if (id === ZERO) {
    const mgmt = keccak256(encodeAbiParameters([{ type: "address" }], [wc.account!.address]));
    await call(wc, pc, core.idFactory, "IdFactory", "createIdentityWithManagementKeys", [wallet, wallet.toLowerCase(), [mgmt]], log, `create identity for ${wallet}`);
    id = await read<Address>(pc, core.idFactory, "IdFactory", "getIdentity", [wallet]);
  }
  return getAddress(id);
}

/** What the issuer's wallet signs (personal_sign over these 32 bytes) for a claim (KYC by default). */
export function kycClaim(identity: Address, statement: string, topic: bigint = KYC_TOPIC) {
  const data = toHex(statement);
  const digest = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [identity, topic, data]));
  return { data, digest };
}

export async function fileKyc(
  wc: WalletClient, pc: PublicClient,
  p: {
    identity: Address; claimIssuer: Address; identityRegistry: Address; wallet: Address; data: Hex; signature: Hex; country: number;
    accredited?: { data: Hex; signature: Hex };
  },
  log: Log = () => {},
) {
  const valid = await read<boolean>(pc, p.claimIssuer, "ClaimIssuer", "isClaimValid", [p.identity, KYC_TOPIC, p.signature, p.data]);
  if (!valid) throw new Error("That signature isn't from this offering's claim issuer key");
  if (p.accredited) {
    const ok = await read<boolean>(pc, p.claimIssuer, "ClaimIssuer", "isClaimValid", [p.identity, ACCREDITED_TOPIC, p.accredited.signature, p.accredited.data]);
    if (!ok) throw new Error("The accreditation signature isn't from this offering's claim issuer key");
  }
  await call(wc, pc, p.identity, "Identity", "addClaim", [KYC_TOPIC, CLAIM_SCHEME_ECDSA, p.claimIssuer, p.signature, p.data, ""], log, "file the KYC claim");
  if (p.accredited) {
    await call(wc, pc, p.identity, "Identity", "addClaim", [ACCREDITED_TOPIC, CLAIM_SCHEME_ECDSA, p.claimIssuer, p.accredited.signature, p.accredited.data, ""], log, "file the accreditation claim");
  }
  const current = await read<Address>(pc, p.identityRegistry, "IdentityRegistry", "identity", [p.wallet]);
  if (current === ZERO) {
    await call(wc, pc, p.identityRegistry, "IdentityRegistry", "registerIdentity", [p.wallet, p.identity, p.country], log, "register the wallet");
  } else if (current.toLowerCase() !== p.identity.toLowerCase()) {
    throw new Error("This wallet is registered to a different identity on this offering");
  }
  return read<boolean>(pc, p.identityRegistry, "IdentityRegistry", "isVerified", [p.wallet]);
}

// ------------------------------------------------------------------ API
type Deps = {
  requireAdmin: any;
  getAsset: (c: any, id: string) => Promise<any | null>;
  saveAsset: (c: any, asset: any) => Promise<void>;
  getTenant: (c: any) => any;
  saveTenant: (c: any, tenant: any) => Promise<void>;
  /** Sanctions screening; returns a reason to refuse, or null. T-REX has no on-chain sanctions hook. */
  screen: (wallet: string, chainId: number) => Promise<string | null>;
  /** On real networks: a reason to refuse when the wallet hasn't passed this issuer's identity check (null = ok). */
  identityGate?: (c: any, wallet: string, chainId: number) => Promise<string | null>;
};
const Wallet = z.object({ wallet: z.string().refine(isAddress, "bad address") });
const Kyc = Wallet.extend({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), country: z.number().int().min(1).max(999) });

/** Resolves the asset, its chain and the platform T-REX core; refuses anything that isn't a testnet ERC-3643 draft. */
async function ctx(c: any, deps: Deps) {
  const asset = await deps.getAsset(c, c.req.param("id"));
  if (!asset) return { err: c.json({ error: "Not found" }, 404) };
  if (asset.standard !== "erc3643") return { err: c.json({ error: "This offering isn't an ERC-3643 token" }, 400) };
  const net = networkById(asset.chainId);
  const core = trexFor(net);
  if (!net || !core) return { err: c.json({ error: `ERC-3643 isn't live on ${net?.name ?? "this network"} yet` }, 409) };
  if (!net.testnet) return { err: c.json({ error: "ERC-3643 is testnet-only for now" }, 409) };
  const wc = relayerFor(net);
  if (!wc) return { err: c.json({ error: "The platform's T-REX relayer isn't configured" }, 503) };
  return { asset, net, core, wc, pc: publicFor(net) };
}

export function mountTrex(app: Hono<any>, deps: Deps) {
  app.post("/assets/:id/trex/prepare", deps.requireAdmin, async (c) => {
    const x = await ctx(c, deps);
    if (x.err) return x.err;
    const { asset, net, core, wc, pc } = x;
    const body = Wallet.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Connect a wallet first" }, 400);
    const wallet = getAddress(body.data.wallet);
    if (asset.status === "deployed") return c.json({ error: "Already deployed" }, 409);
    try {
      const out = await serial(net.id, async () => {
        const tenant = deps.getTenant(c);
        const key = `${net.id}:${wallet.toLowerCase()}`;
        let claimIssuer = tenant.claimIssuers?.[key] as Address | undefined;
        if (!claimIssuer) {
          claimIssuer = await deployClaimIssuer(wc, pc, wallet);
          await deps.saveTenant(c, { ...tenant, claimIssuers: { ...(tenant.claimIssuers ?? {}), [key]: claimIssuer } });
        }
        if (asset.trex?.owner && asset.trex.owner.toLowerCase() !== wallet.toLowerCase()) {
          throw new Error(`This offering's suite belongs to ${asset.trex.owner}; connect that wallet`);
        }
        const rules = Rules.parse(asset.rules ?? {});
        const settings = moduleSettings(rules, asset);
        const module = settings.length ? (asset.trex?.rulesModule ?? await ensureRulesModule(wc, pc, net)) : undefined;
        const suite = await deploySuite(wc, pc, core, {
          salt: `${asset.tenantId ?? tenant.id}:${asset.id}`, owner: wallet, name: asset.name, symbol: asset.symbol, claimIssuer,
          accreditedOnly: rules.accreditedOnly, module, settings,
        });
        // Keep the first recorded deploy block on retries (an idempotent re-run doesn't know it).
        const deployBlock = suite.deployBlock ?? asset.trex?.deployBlock ?? null;
        const trex = { ...suite, deployBlock, claimIssuer, owner: wallet, ...(module ? { rulesModule: module } : {}), accreditedOnly: rules.accreditedOnly, salt: `${asset.tenantId ?? tenant.id}:${asset.id}`, referenceAuthority: core.implementationAuthority };
        await deps.saveAsset(c, { ...asset, trex });
        return trex;
      });
      return c.json(out);
    } catch (e: any) {
      console.error("[trex] prepare", asset.id, e?.shortMessage ?? e?.message ?? e);
      return c.json({ error: e?.shortMessage ?? e?.message ?? "Couldn't deploy the suite" }, 422);
    }
  });

  app.post("/assets/:id/trex/identity", deps.requireAdmin, async (c) => {
    const x = await ctx(c, deps);
    if (x.err) return x.err;
    const { asset, net, core, wc, pc } = x;
    if (!asset.trex?.identityRegistry) return c.json({ error: "Deploy the offering first" }, 409);
    const body = Wallet.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Enter the investor's wallet address" }, 400);
    const wallet = getAddress(body.data.wallet);
    try {
      const identity = await serial(net.id, () => ensureIdentity(wc, pc, core, wallet));
      const tenant = deps.getTenant(c);
      // Full timestamp: re-verifying after a revoke must give a NEW signature (ECDSA signatures are deterministic and the
      // revoked one stays blacklisted on the claim issuer).
      const statement = `KYC passed for ${wallet} · ${tenant.name ?? tenant.id} · ${new Date().toISOString().slice(0, 19)}Z`;
      const { data, digest } = kycClaim(identity, statement);
      // Accredited-only offerings: a second claim the issuer signs once it has checked accreditation.
      const accredited = asset.trex.accreditedOnly
        ? (() => {
            const st = `Accredited investor ${wallet} · ${tenant.name ?? tenant.id} · ${new Date().toISOString().slice(0, 19)}Z`;
            return { ...kycClaim(identity, st, ACCREDITED_TOPIC), statement: st };
          })()
        : undefined;
      return c.json({ identity, data, digest, claimIssuer: asset.trex.claimIssuer, signer: asset.trex.owner, statement, accredited });
    } catch (e: any) {
      console.error("[trex] identity", asset.id, e?.shortMessage ?? e?.message ?? e);
      return c.json({ error: e?.shortMessage ?? e?.message ?? "Couldn't create the identity" }, 422);
    }
  });

  app.post("/assets/:id/trex/kyc", deps.requireAdmin, async (c) => {
    const x = await ctx(c, deps);
    if (x.err) return x.err;
    const { asset, net, core, wc, pc } = x;
    if (!asset.trex?.identityRegistry) return c.json({ error: "Deploy the offering first" }, 409);
    const Claim = z.object({ data: z.string().regex(/^0x[0-9a-fA-F]{2,2000}$/), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });
    const body = Kyc.extend({ data: z.string().regex(/^0x[0-9a-fA-F]{2,2000}$/), accredited: Claim.optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Missing wallet, country or signature" }, 400);
    if (asset.trex.accreditedOnly && !body.data.accredited) return c.json({ error: "This offering is for accredited investors only: sign the accreditation claim too" }, 400);
    const wallet = getAddress(body.data.wallet);
    const refused = await deps.screen(wallet, net.id);
    if (refused) return c.json({ error: refused }, 403);
    const noId = deps.identityGate ? await deps.identityGate(c, wallet, net.id) : null;
    if (noId) return c.json({ error: noId, needsIdentity: true }, 403);
    try {
      const verified = await serial(net.id, async () => {
        const identity = await ensureIdentity(wc, pc, core, wallet);
        return fileKyc(wc, pc, {
          identity, claimIssuer: asset.trex.claimIssuer, identityRegistry: asset.trex.identityRegistry, wallet,
          data: body.data.data as Hex, signature: body.data.signature as Hex, country: body.data.country,
          accredited: body.data.accredited as { data: Hex; signature: Hex } | undefined,
        });
      });
      return c.json({ wallet, verified });
    } catch (e: any) {
      console.error("[trex] kyc", asset.id, e?.shortMessage ?? e?.message ?? e);
      return c.json({ error: e?.shortMessage ?? e?.message ?? "Couldn't file the claim" }, 422);
    }
  });
}

export { T as TREX_ARTIFACTS };
