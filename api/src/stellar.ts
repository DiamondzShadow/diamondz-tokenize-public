// Stellar (Soroban) edition: read-only views of Stellar RWA tokens (OpenZeppelin Stellar Contracts RWA / ERC-3643 port).
//
// Every read is a simulateTransaction from a random, never-funded source account, so this server holds no Stellar key
// and cannot write to Stellar. Compliance and every transfer live in the Soroban contracts (see stellar/ in the repo).
//   GET /api/stellar/:network/:contract                     → { name, symbol, decimals, totalSupply, paused, ledger }
//   GET /api/stellar/:network/:contract/balance/:account    → { account, balance, frozen }
// network = testnet | mainnet. Mainnet RPC: STELLAR_MAINNET_RPC (default the public mainnet.sorobanrpc.com, listed on
// developers.stellar.org/docs/data/apis/rpc/providers). Results are cached briefly; identical reads share one call.
import type { Hono } from "hono";
import { stellarRpcUrl } from "./chains";
import {
  Account, Address, BASE_FEE, Contract, Keypair, Networks, StrKey, TransactionBuilder, rpc, scValToNative, type xdr,
} from "@stellar/stellar-sdk";

type Net = "testnet" | "mainnet";
const NETS: Record<Net, { rpc: string; passphrase: string }> = {
  testnet: { rpc: stellarRpcUrl("testnet", "https://soroban-testnet.stellar.org"), passphrase: Networks.TESTNET },
  mainnet: { rpc: stellarRpcUrl("mainnet", "https://mainnet.sorobanrpc.com"), passphrase: Networks.PUBLIC },
};
const CACHE_MS = 15_000;
const servers = new Map<Net, rpc.Server>();
const server = (n: Net) => servers.get(n) ?? servers.set(n, new rpc.Server(NETS[n].rpc)).get(n)!;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export const isNet = (s: string): s is Net => s === "testnet" || s === "mainnet";

/** Read-only contract call. Throws with the contract's error text when the simulation fails. */
export async function readContract(net: Net, contract: string, fn: string, args: xdr.ScVal[] = [], opts: { fresh?: boolean } = {}): Promise<unknown> {
  const key = `${net}|${contract}|${fn}|${args.map((a) => a.toXDR("base64")).join(",")}`;
  const hit = cache.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = (async () => {
    const src = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: NETS[net].passphrase })
      .addOperation(new Contract(contract).call(fn, ...args)).setTimeout(30).build();
    const sim = await server(net).simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${(sim.error.split("\n")[0] ?? "").slice(0, 200)}`);
    if (!sim.result) throw new Error(`${fn}: no result`);
    return scValToNative(sim.result.retval);
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 2_000) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return value;
}

export async function tokenInfo(net: Net, contract: string) {
  const [name, symbol, decimals, totalSupply, paused, latest] = await Promise.all([
    readContract(net, contract, "name"),
    readContract(net, contract, "symbol"),
    readContract(net, contract, "decimals"),
    readContract(net, contract, "total_supply"),
    readContract(net, contract, "paused"),
    server(net).getLatestLedger(),
  ]);
  return {
    network: net, contract, name: String(name), symbol: String(symbol), decimals: Number(decimals),
    totalSupply: String(totalSupply), paused: Boolean(paused), ledger: latest.sequence,
  };
}

const isAccount = (a: string) => StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a);

export function mountStellar(app: Hono<any>) {
  app.get("/stellar/:network/:contract", async (c) => {
    const { network, contract } = c.req.param();
    if (!isNet(network)) return c.json({ error: "network must be testnet or mainnet" }, 400);
    if (!StrKey.isValidContract(contract)) return c.json({ error: "not a Soroban contract id" }, 400);
    try {
      c.header("cache-control", "public, max-age=15");
      return c.json(await tokenInfo(network, contract));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  app.get("/stellar/:network/:contract/balance/:account", async (c) => {
    const { network, contract, account } = c.req.param();
    if (!isNet(network)) return c.json({ error: "network must be testnet or mainnet" }, 400);
    if (!StrKey.isValidContract(contract)) return c.json({ error: "not a Soroban contract id" }, 400);
    if (!isAccount(account)) return c.json({ error: "not a Stellar account (G…) or contract (C…)" }, 400);
    try {
      const who = new Address(account).toScVal();
      const [balance, frozen] = await Promise.all([
        readContract(network, contract, "balance", [who]),
        readContract(network, contract, "is_frozen", [who]).catch(() => null),
      ]);
      c.header("cache-control", "public, max-age=15");
      return c.json({ network, contract, account, balance: String(balance), frozen: frozen === null ? null : Boolean(frozen) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });
}
