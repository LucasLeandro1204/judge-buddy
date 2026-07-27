/**
 * Hedera access from the Workers runtime.
 *
 * Everything here goes over HTTP: the EVM JSON-RPC relay (hashio) via ethers, and the Mirror
 * Node REST API via fetch. Both work inside Workers.
 *
 * What is deliberately absent is @hashgraph/sdk. It speaks gRPC over HTTP/2 with Node crypto
 * and does not run on Workers, which means the HCS topic writes the Express server performed
 * cannot happen here. The audit trail is not lost though — HackathonTreasury emits
 * EvaluationFinalized, AwardProposed, AwardApproved and PayoutReleased, all carrying the same
 * evidence hashes, and those are readable on HashScan and through the Mirror Node. HCS
 * mirroring is tracked as a follow-up rather than faked.
 */
import { Contract, JsonRpcProvider, Wallet, Interface, keccak256, toUtf8Bytes } from "ethers";
import { HACKATHON_TREASURY_ABI, PRIZE_CLAIM_TOKEN_ABI } from "../../../packages/shared/src/abi.js";
import type { Env } from "./env.js";

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;

export const treasuryInterface = new Interface(HACKATHON_TREASURY_ABI as unknown as string[]);

/**
 * Hedera's JSON-RPC relay does not implement eth_feeHistory the way ethers' default fee logic
 * expects, and batching confuses it. staticNetwork avoids a chain-id round trip per call.
 */
export function getProvider(env: Env): JsonRpcProvider {
  return new JsonRpcProvider(
    env.HEDERA_EVM_RPC,
    { chainId: Number(env.HEDERA_CHAIN_ID ?? 296), name: "hedera-testnet" },
    { staticNetwork: true, batchMaxCount: 1 },
  );
}

export function getTreasuryRead(env: Env): Contract {
  if (!env.TREASURY_CONTRACT_ADDRESS) throw new Error("TREASURY_CONTRACT_ADDRESS is not configured");
  return new Contract(env.TREASURY_CONTRACT_ADDRESS, HACKATHON_TREASURY_ABI as unknown as string[], getProvider(env));
}

/** Write contract signed by the agent relayer. Never expose this to a request path a user controls. */
export function getTreasuryWrite(env: Env): Contract {
  if (!env.TREASURY_CONTRACT_ADDRESS) throw new Error("TREASURY_CONTRACT_ADDRESS is not configured");
  if (!env.TREASURY_RELAYER_PRIVATE_KEY) throw new Error("TREASURY_RELAYER_PRIVATE_KEY is not configured");
  const wallet = new Wallet(env.TREASURY_RELAYER_PRIVATE_KEY, getProvider(env));
  return new Contract(env.TREASURY_CONTRACT_ADDRESS, HACKATHON_TREASURY_ABI as unknown as string[], wallet);
}

export function getClaimTokenRead(env: Env): Contract | null {
  if (!env.PRIZE_CLAIM_TOKEN_ADDRESS) return null;
  return new Contract(
    env.PRIZE_CLAIM_TOKEN_ADDRESS,
    PRIZE_CLAIM_TOKEN_ABI as unknown as string[],
    getProvider(env),
  );
}

/**
 * Hedera gas estimation through the relay is unreliable for contract calls that touch system
 * contracts, so every write passes an explicit limit.
 */
export const GAS_LIMITS = {
  // Hedera refunds at most 20% of an unused limit, so an over-sized limit is charged at 80% of
  // the limit no matter what the call actually used. These are sized just above real usage:
  // a 1,500,000 limit on a payout costs ~1.5 HBAR whether or not the call needs it.
  registerSubmission: 250_000,
  recordEvaluation: 150_000,
  proposeAward: 400_000,
  executeAutonomousPayout: 500_000,
  executeApprovedAward: 800_000,
  redeemClaim: 800_000,
} as const;

export const hashScan = {
  tx: (network: string, txHash: string) => `https://hashscan.io/${network}/transaction/${txHash}`,
  contract: (network: string, address: string) => `https://hashscan.io/${network}/contract/${address}`,
  account: (network: string, accountId: string) => `https://hashscan.io/${network}/account/${accountId}`,
  token: (network: string, tokenId: string) => `https://hashscan.io/${network}/token/${tokenId}`,
};

export type MirrorAccount = {
  account: string;
  evm_address: string | null;
  balance?: { balance: number };
};

/** Resolves a 0.0.x account through the Mirror Node. Returns null when unknown. */
export async function fetchMirrorAccount(env: Env, accountId: string): Promise<MirrorAccount | null> {
  const url = `${env.HEDERA_MIRROR_BASE}/api/v1/accounts/${encodeURIComponent(accountId)}`;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return (await response.json()) as MirrorAccount;
  } catch {
    return null;
  }
}

/**
 * Confirms a Hedera account ID really maps to the EVM address that just signed.
 * Without this, anyone could claim any 0.0.x account by signing with their own key.
 */
export async function accountMatchesEvmAddress(
  env: Env,
  accountId: string,
  evmAddress: string,
): Promise<boolean> {
  const account = await fetchMirrorAccount(env, accountId);
  if (!account?.evm_address) return false;
  return account.evm_address.toLowerCase() === evmAddress.toLowerCase();
}

export function hashEvidence(value: unknown): string {
  return keccak256(toUtf8Bytes(typeof value === "string" ? value : JSON.stringify(value)));
}

/**
 * Hedera mines quickly but the relay can lag behind consensus, so a receipt is sometimes not
 * available immediately after a transaction is accepted. Poll rather than trusting one call.
 */
export async function waitForReceipt(
  provider: JsonRpcProvider,
  txHash: string,
  { attempts = 12, delayMs = 1500 }: { attempts?: number; delayMs?: number } = {},
) {
  for (let i = 0; i < attempts; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}
