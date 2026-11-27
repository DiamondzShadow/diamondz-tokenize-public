// Investor identity check (Sumsub KYC) state on the investor's side. The server hands out a private check id when the
// investor signs once with their wallet; this browser keeps it per (issuer, wallet) so status can be read without
// signing again. Without it, a wallet's status can't be looked up by anyone.
import { useEffect, useState } from "react";
import { api, type KycStatus } from "./api";
import { ensureChain, walletClientFor } from "./wallet";

const key = (tenantId: string, wallet: string) => `kyc:${tenantId}:${wallet.toLowerCase()}`;
export const loadKycId = (tenantId: string, wallet: string) => { try { return localStorage.getItem(key(tenantId, wallet)); } catch { return null; } };
const saveKycId = (tenantId: string, wallet: string, id: string | null) => {
  try { id ? localStorage.setItem(key(tenantId, wallet), id) : localStorage.removeItem(key(tenantId, wallet)); } catch { /* status just won't survive a reload */ }
};

export const kycMessage = (p: { tenantId: string; wallet: string; ts: number }) =>
  `Diamondz Tokenize identity check\nIssuer: ${p.tenantId}\nWallet: ${p.wallet}\nTime: ${p.ts}`;

/** Asks the wallet to sign once, then returns the check id + a Sumsub SDK token. */
export async function startKyc(tenantId: string, wallet: `0x${string}`, chainId: number, assetId?: string) {
  await ensureChain(chainId); // thirdweb logins need their provider built for this network before they can sign
  const ts = Math.floor(Date.now() / 1000);
  const signature = await walletClientFor(chainId, wallet).signMessage({ account: wallet, message: kycMessage({ tenantId, wallet, ts }) });
  const r = await api.kycStart({ wallet, chainId, ts, signature, ...(assetId ? { assetId } : {}) });
  saveKycId(tenantId, wallet, r.id);
  return r;
}

/** The current check for this wallet with this issuer (null = never started here). Polls while Sumsub is checking. */
export function useKycStatus(tenantId: string | undefined, wallet: string | null | undefined) {
  const [status, setStatus] = useState<KycStatus | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!tenantId || !wallet) { setStatus(undefined); return; }
    const id = loadKycId(tenantId, wallet);
    if (!id) { setStatus(null); return; }
    let live = true;
    const pull = () => api.kycStatus(id, wallet).then((s) => live && setStatus(s), () => { if (live) { saveKycId(tenantId, wallet, null); setStatus(null); } });
    pull();
    const t = setInterval(() => { setStatus((s) => { if (s && (s.status === "pending" || s.status === "init")) pull(); return s; }); }, 8000);
    return () => { live = false; clearInterval(t); };
  }, [tenantId, wallet, tick]);
  return { status, reload: () => setTick((n) => n + 1), set: setStatus };
}
