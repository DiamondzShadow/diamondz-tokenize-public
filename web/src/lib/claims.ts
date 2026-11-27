// Issuer-signed investor claims on Stellar mainnet: the issuer names one EVM wallet (a hardware wallet behind MetaMask
// works) that signs every investor claim with personal_sign. Shared by the app and the API so the message matches.
import { getAddress } from "viem";

export const claimSignerMessage = (assetId: string, n: { name: string }, address: string) =>
  `Diamondz Tokenize: ${getAddress(address)} signs investor claims for offering ${assetId} on ${n.name}.`;
