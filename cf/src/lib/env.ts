/** Bindings and configuration available to the Worker. Mirrors wrangler.jsonc. */
export type Env = {
  // bindings
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;

  // vars
  HEDERA_NETWORK: string;
  HEDERA_EVM_RPC: string;
  HEDERA_MIRROR_BASE: string;
  HEDERA_CHAIN_ID: string;
  WORKERS_AI_MODEL: string;
  JOBS_PER_CRON: string;

  // set by the deploy script once the contracts exist
  TREASURY_CONTRACT_ADDRESS?: string;
  PRIZE_CLAIM_TOKEN_ADDRESS?: string;
  PAYOUT_TOKEN_ADDRESS?: string;

  // secrets
  SESSION_SECRET: string;
  TREASURY_RELAYER_PRIVATE_KEY?: string;
  /** Optional. Lifts the GitHub API limit from 60 req/hour to 5000, so evidence lookups stop
   *  going indeterminate under load. The pipeline works without it. */
  GITHUB_TOKEN?: string;
};

export function chainId(env: Env): number {
  const parsed = Number.parseInt(env.HEDERA_CHAIN_ID ?? "296", 10);
  return Number.isFinite(parsed) ? parsed : 296;
}

export function jobsPerCron(env: Env): number {
  const parsed = Number.parseInt(env.JOBS_PER_CRON ?? "5", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

/** True when the treasury address and a relayer key are both present. */
export function canWriteChain(env: Env): boolean {
  return Boolean(env.TREASURY_CONTRACT_ADDRESS && env.TREASURY_RELAYER_PRIVATE_KEY);
}
