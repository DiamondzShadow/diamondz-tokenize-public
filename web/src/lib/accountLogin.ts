// Issuer sign-in with thirdweb (Google, Apple, email code) — no wallet UI (designs S2/S6). thirdweb logs the person in;
// the login's account then signs our one-time message, which the server verifies. We keep thirdweb's session (logging
// it out would also sign the same person out of their investor wallet on the marketplace, same thirdweb project).
import { createThirdwebClient } from "thirdweb";
import { getUserEmail, inAppWallet, preAuthenticate } from "thirdweb/wallets";
import { getAddress } from "viem";
import { api } from "./api";

const clients = new Map<string, ReturnType<typeof createThirdwebClient>>();
const clientFor = (id: string) => { if (!clients.has(id)) clients.set(id, createThirdwebClient({ clientId: id })); return clients.get(id)!; };

export async function sendEmailCode(clientId: string, email: string) {
  await preAuthenticate({ client: clientFor(clientId), strategy: "email", email });
}

export type LoginWith = { strategy: "google" | "apple" } | { strategy: "email"; email: string; code: string };

export async function signInWithThirdweb(clientId: string, how: LoginWith) {
  const client = clientFor(clientId);
  const wallet = inAppWallet();
  const account = how.strategy === "email"
    ? await wallet.connect({ client, strategy: "email", email: how.email, verificationCode: how.code })
    : await wallet.connect({ client, strategy: how.strategy });
  const address = getAddress(account.address);
  const email = (await getUserEmail({ client }).catch(() => undefined)) ?? (how.strategy === "email" ? how.email : undefined);
  const n = await api.authNonce();
  const signature = await account.signMessage({ message: n.message.replace("{address}", address) });
  return api.authThirdweb({ address, chainId: 84532, nonce: n.nonce, issuedAt: n.issuedAt, signature, ...(email ? { email } : {}) });
}
