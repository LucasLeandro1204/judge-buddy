/**
 * JudgeBuddy on Cloudflare Workers.
 *
 * One Worker serves three things:
 *   - the built Vite app (via the ASSETS binding, SPA fallback so deep links survive a refresh)
 *   - the JSON API under /api
 *   - a cron handler that drains the agent job queue
 *
 * Replaces the Express server (server/src/index.ts) and the polling worker
 * (worker/src/index.ts), neither of which can run on this runtime.
 */
import { Hono } from "hono";
import { id as toOnchainId, verifyMessage } from "ethers";
import type { Env } from "./lib/env.js";
import { canWriteChain, jobsPerCron } from "./lib/env.js";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  buildSignedMessage,
  consumeNonce,
  issueChallenge,
  issueSession,
  pruneNonces,
  readChallenge,
  readCookie,
  readSession,
  sessionCookie,
  type SessionPayload,
} from "./lib/session.js";
import { accountMatchesEvmAddress, getProvider, getTreasuryWrite, hashScan, treasuryInterface, waitForReceipt, GAS_LIMITS } from "./lib/hedera.js";
import { handleJob } from "./agents/pipeline.js";
import * as store from "./db/store.js";
import {
  createHackathonRequestSchema,
  createSubmissionRequestSchema,
} from "../../packages/shared/src/treasury.js";

type Vars = { user: SessionPayload | null };

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── middleware ──────────────────────────────────────────────────────────────

api.use("*", async (c, next) => {
  const token = readCookie(c.req.raw, SESSION_COOKIE);
  c.set("user", await readSession(token, c.env.SESSION_SECRET));
  await next();
});

/** Rejects with 401 rather than letting a route silently act as nobody. */
function requireUser(c: { get: (k: "user") => SessionPayload | null }): SessionPayload {
  const user = c.get("user");
  if (!user) throw new HttpError(401, "Sign in with your wallet first.");
  return user;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

api.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
  console.error("[api] unhandled", error);
  return c.json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
});

// ── health ──────────────────────────────────────────────────────────────────

api.get("/health", async (c) => {
  const env = c.env;
  let dbOk = true;
  try {
    await env.DB.prepare("select 1").first();
  } catch {
    dbOk = false;
  }

  // The first six fields are the contract the frontend already consumes (HealthResponse in
  // src/hackathon/api.ts). Renaming them would show the API as permanently "offline".
  return c.json({
    ok: dbOk,
    network: env.HEDERA_NETWORK,
    mirrorBase: env.HEDERA_MIRROR_BASE,
    hederaEvmRpc: env.HEDERA_EVM_RPC,
    treasuryContractConfigured: Boolean(env.TREASURY_CONTRACT_ADDRESS),
    prizeClaimTokenConfigured: Boolean(env.PRIZE_CLAIM_TOKEN_ADDRESS),

    // additive detail
    database: dbOk ? "ok" : "unreachable",
    chain: {
      canWrite: canWriteChain(env),
      treasuryContractAddress: env.TREASURY_CONTRACT_ADDRESS ?? null,
      prizeClaimTokenAddress: env.PRIZE_CLAIM_TOKEN_ADDRESS ?? null,
      payoutTokenAddress: env.PAYOUT_TOKEN_ADDRESS ?? null,
      explorer: env.TREASURY_CONTRACT_ADDRESS
        ? hashScan.contract(env.HEDERA_NETWORK, env.TREASURY_CONTRACT_ADDRESS)
        : null,
    },
    agents: { provider: "workers-ai", model: env.WORKERS_AI_MODEL },
  });
});

// ── auth ────────────────────────────────────────────────────────────────────

api.post("/auth/nonce", async (c) => {
  const body = await c.req.json<{ accountId?: string; evmAddress?: string }>();
  const accountId = String(body.accountId ?? "");
  const evmAddress = String(body.evmAddress ?? "");

  if (!/^\d+\.\d+\.\d+$/.test(accountId)) throw new HttpError(400, "accountId must look like 0.0.1234");
  if (!/^0x[a-fA-F0-9]{40}$/.test(evmAddress)) throw new HttpError(400, "evmAddress is not a valid EVM address");

  // Without this check anyone could claim any Hedera account by signing with their own key.
  const matches = await accountMatchesEvmAddress(c.env, accountId, evmAddress);
  if (!matches) {
    throw new HttpError(400, `Account ${accountId} does not resolve to ${evmAddress} on the mirror node.`);
  }

  const { token, payload } = await issueChallenge({ accountId, evmAddress }, c.env.SESSION_SECRET);
  return c.json({
    challenge: token,
    challengeId: payload.challengeId,
    nonce: payload.nonce,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    message: buildSignedMessage(payload, c.env.HEDERA_NETWORK, "metamask"),
  });
});

api.post("/auth/verify", async (c) => {
  const body = await c.req.json<{ challenge?: string; signature?: string }>();
  const payload = await readChallenge(String(body.challenge ?? ""), c.env.SESSION_SECRET);
  if (!payload) throw new HttpError(400, "Challenge is invalid or has expired. Try signing in again.");

  const message = buildSignedMessage(payload, c.env.HEDERA_NETWORK, "metamask");
  let recovered: string;
  try {
    recovered = verifyMessage(message, String(body.signature ?? ""));
  } catch {
    throw new HttpError(400, "Signature could not be verified.");
  }
  if (recovered.toLowerCase() !== payload.evmAddress.toLowerCase()) {
    throw new HttpError(401, "Signature does not match the address that requested the challenge.");
  }

  if (!(await consumeNonce(c.env.DB, payload))) {
    throw new HttpError(400, "This challenge has already been used.");
  }

  const user: Omit<SessionPayload, "exp"> = {
    accountId: payload.accountId,
    evmAddress: payload.evmAddress,
    walletSource: "metamask",
    network: c.env.HEDERA_NETWORK === "mainnet" ? "mainnet" : "testnet",
  };
  const token = await issueSession(user, c.env.SESSION_SECRET);
  c.header("Set-Cookie", sessionCookie(token, SESSION_MAX_AGE));
  return c.json({ user });
});

api.get("/auth/session", (c) => c.json({ user: c.get("user") }));

api.post("/auth/logout", (c) => {
  c.header("Set-Cookie", sessionCookie("", 0));
  return c.json({ ok: true });
});

// ── hackathons ──────────────────────────────────────────────────────────────

api.get("/hackathons", async (c) => c.json(await store.listHackathons(c.env.DB)));

api.get("/hackathons/:id", async (c) => {
  const hackathon = await store.getHackathon(c.env.DB, c.req.param("id"));
  if (!hackathon) throw new HttpError(404, "Hackathon not found");

  const [submissions, approvals, claims] = await Promise.all([
    store.listSubmissions(c.env.DB, hackathon.id),
    store.listApprovalRequests(c.env.DB, hackathon.id),
    store.listPrizeClaims(c.env.DB, hackathon.id),
  ]);

  // Clustering is produced by the cluster_submissions job and read straight from D1. Computing
  // it here cost 8-9s of Workers AI latency on every page view.
  const similarityClusters = await store.listSimilarityClusters(c.env.DB, hackathon.id);

  // HackathonDetail is `HackathonRecord & { submissions, approvals, claims, similarityClusters }`
  // (src/hackathon/api.ts:16) — the record's fields are spread at the top level, not nested.
  return c.json({ ...hackathon, submissions, approvals, claims, similarityClusters });
});

api.post("/hackathons", async (c) => {
  const user = requireUser(c);
  const parsed = createHackathonRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));

  if (parsed.data.organizerAccountId !== user.accountId) {
    throw new HttpError(403, "You can only create a program for the account you signed in with.");
  }

  const hackathon = await store.createHackathon(c.env.DB, parsed.data);
  await store.recordEvent(c.env.DB, {
    scope: "hackathon",
    source: "api",
    type: "hackathon.created",
    actor: user.accountId,
    hackathonId: hackathon.id,
    submissionId: null,
    awardId: null,
    claimId: null,
    txHash: null,
    payload: { name: hackathon.name, tracks: hackathon.tracks.length },
  });
  return c.json(hackathon, 201);
});

api.post("/hackathons/:id/fund", async (c) => {
  const user = requireUser(c);
  const hackathonId = c.req.param("id");
  const body = await c.req.json<{ txHash?: string }>();
  const txHash = String(body.txHash ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, "txHash must be a 0x-prefixed 32-byte hash");

  const hackathon = await store.getHackathon(c.env.DB, hackathonId);
  if (!hackathon) throw new HttpError(404, "Hackathon not found");
  if (hackathon.organizerAccountId !== user.accountId) {
    throw new HttpError(403, "Only the organizer can confirm funding.");
  }

  const receipt = await waitForReceipt(getProvider(c.env), txHash);
  if (!receipt) throw new HttpError(400, "That transaction has not been confirmed yet. Try again in a moment.");
  if (receipt.status !== 1) throw new HttpError(400, "That transaction reverted on-chain.");

  // Only accept the tx if it really created THIS hackathon in the treasury, and take the
  // per-track deposit amounts from the emitted events rather than trusting the client.
  let matched = false;
  const deposits: Array<{ trackId: string; amount: string }> = [];
  const expectedHackathonId = toOnchainId(hackathonId);

  for (const log of receipt.logs) {
    let parsedLog;
    try {
      parsedLog = treasuryInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue; // not a treasury log
    }
    if (!parsedLog) continue;

    if (parsedLog.name === "HackathonCreated" && parsedLog.args.hackathonId === expectedHackathonId) {
      matched = true;
    }
    if (parsedLog.name === "TreasuryFunded" && parsedLog.args.hackathonId === expectedHackathonId) {
      // The on-chain track id is keccak(trackId), so map it back to the stored track.
      const onchainTrackId = String(parsedLog.args.trackId);
      const track = hackathon.tracks.find((entry) => toOnchainId(entry.id) === onchainTrackId);
      if (track) deposits.push({ trackId: track.id, amount: String(parsedLog.args.amount) });
    }
  }

  if (!matched) {
    throw new HttpError(400, "That transaction does not create this program in the treasury contract.");
  }

  await store.markHackathonFunded(c.env.DB, {
    hackathonId,
    txHash,
    sponsorAccountId: user.accountId,
    sponsorEvmAddress: user.evmAddress,
    tokenId: hackathon.payoutTokenId,
    deposits,
  });
  await store.recordEvent(c.env.DB, {
    scope: "hackathon",
    source: "chain",
    type: "treasury.funded",
    actor: user.accountId,
    hackathonId,
    submissionId: null,
    awardId: null,
    claimId: null,
    txHash,
    payload: { explorer: hashScan.tx(c.env.HEDERA_NETWORK, txHash) },
  });

  return c.json({ ok: true, txHash, explorer: hashScan.tx(c.env.HEDERA_NETWORK, txHash) });
});

// ── submissions ─────────────────────────────────────────────────────────────

api.get("/submissions", async (c) => {
  const hackathonId = c.req.query("h");
  if (!hackathonId) throw new HttpError(400, "Pass ?h=<hackathonId>");
  return c.json(await store.listSubmissions(c.env.DB, hackathonId));
});

api.post("/submissions", async (c) => {
  const parsed = createSubmissionRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));

  const hackathon = await store.getHackathon(c.env.DB, parsed.data.hackathonId);
  if (!hackathon) throw new HttpError(404, "Hackathon not found");
  if (!hackathon.tracks.some((track) => track.id === parsed.data.trackId)) {
    throw new HttpError(400, "That track does not belong to this program.");
  }

  const submission = await store.createSubmission(c.env.DB, parsed.data);
  await store.enqueueJob(c.env.DB, "evaluate_submission", { submissionId: submission.id });
  await store.recordEvent(c.env.DB, {
    scope: "submission",
    source: "api",
    type: "submission.created",
    actor: submission.payoutAccountId,
    hackathonId: submission.hackathonId,
    submissionId: submission.id,
    awardId: null,
    claimId: null,
    txHash: null,
    payload: { projectName: submission.projectName },
  });

  return c.json(submission, 201);
});

api.get("/submissions/:id", async (c) => {
  const submission = await store.getSubmission(c.env.DB, c.req.param("id"));
  if (!submission) throw new HttpError(404, "Submission not found");
  return c.json(submission);
});

api.post("/submissions/:id/evaluate", async (c) => {
  const submission = await store.getSubmission(c.env.DB, c.req.param("id"));
  if (!submission) throw new HttpError(404, "Submission not found");
  const jobId = await store.enqueueJob(c.env.DB, "evaluate_submission", { submissionId: submission.id });
  return c.json({ ok: true, jobId });
});

// ── approvals and claims ────────────────────────────────────────────────────

api.get("/approvals", async (c) => c.json(await store.listApprovalRequests(c.env.DB, c.req.query("h"))));

api.post("/awards/:id/approve", async (c) => {
  const user = requireUser(c);
  const awardId = c.req.param("id");
  const body = await c.req.json<{ signature?: string }>();
  const signature = String(body.signature ?? "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new HttpError(400, "signature must be a 65-byte hex string");

  const award = await store.getAwardProposal(c.env.DB, awardId);
  if (!award) throw new HttpError(404, "Award not found");
  const request = await store.getApprovalRequestByAwardId(c.env.DB, awardId);
  if (!request) throw new HttpError(404, "No approval request exists for this award");

  const hackathon = await store.getHackathon(c.env.DB, award.hackathonId);
  if (!hackathon) throw new HttpError(404, "Hackathon not found");
  if (user.accountId !== hackathon.judgeAccountId && user.accountId !== hackathon.organizerAccountId) {
    throw new HttpError(403, `Only ${hackathon.judgeAccountId} (judge) or the organizer can approve this award.`);
  }
  if (!canWriteChain(c.env)) throw new HttpError(503, "Treasury is not configured on this deployment.");

  const typedData = request.typedData as { value: Record<string, unknown> };
  const treasury = getTreasuryWrite(c.env);
  const tx = await treasury.executeApprovedAward(typedData.value, signature, {
    gasLimit: GAS_LIMITS.executeApprovedAward,
  });
  const receipt = await tx.wait();
  const txHash = receipt?.hash ?? tx.hash;

  await store.markApprovalApproved(c.env.DB, { awardId, signature, status: "executed" });
  await store.updateAwardProposal(c.env.DB, {
    id: awardId,
    status: award.settlementMode === "claim_token" ? "claim_minted" : "paid_out",
    txHash,
  });

  // In claim-token mode the contract has just minted a prize-claim NFT. Record it, or the winner
  // has nothing to redeem: POST /claims/:id/redeem looks the row up and the claims list stays
  // empty while the NFT exists on-chain. Serial and metadata are read back from the emitted
  // ClaimMinted event rather than recomputed, so the row describes what was actually minted.
  if (award.settlementMode === "claim_token") {
    const minted = receipt?.logs
      ?.map((log) => {
        try {
          return treasury.interface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          return null; // A log from another contract, or one this ABI does not describe.
        }
      })
      .find((parsed) => parsed?.name === "ClaimMinted");

    await store.upsertPrizeClaim(c.env.DB, {
      awardId,
      claimantAccountId: award.winnerAccountId,
      claimantEvmAddress: award.winnerEvmAddress,
      tokenAddress: minted ? String(minted.args.claimToken) : c.env.PRIZE_CLAIM_TOKEN_ADDRESS ?? null,
      serialNumber: minted ? String(minted.args.serialNumber) : null,
      metadataURI: minted ? String(minted.args.metadataURI) : null,
      status: "minted",
      mintedTxHash: txHash,
    });
  }

  await store.recordEvent(c.env.DB, {
    scope: "award",
    source: "chain",
    type: "award.approved",
    actor: user.accountId,
    hackathonId: award.hackathonId,
    submissionId: award.submissionId,
    awardId,
    claimId: null,
    txHash,
    payload: { settlementMode: award.settlementMode, explorer: hashScan.tx(c.env.HEDERA_NETWORK, txHash) },
  });

  return c.json({ ok: true, txHash, explorer: hashScan.tx(c.env.HEDERA_NETWORK, txHash) });
});

api.get("/claims", async (c) => c.json(await store.listPrizeClaims(c.env.DB, c.req.query("h"))));

api.post("/claims/:id/redeem", async (c) => {
  const user = requireUser(c);
  const claim = await store.getPrizeClaim(c.env.DB, c.req.param("id"));
  if (!claim) throw new HttpError(404, "Claim not found");
  if (claim.claimantAccountId !== user.accountId) {
    throw new HttpError(403, `Only ${claim.claimantAccountId} can redeem this claim.`);
  }
  if (!canWriteChain(c.env)) throw new HttpError(503, "Treasury is not configured on this deployment.");

  const treasury = getTreasuryWrite(c.env);
  // keccak of the string id, not the string itself — awardId is bytes32 on the contract, and
  // every other call site (registerSubmission, proposeAward, the approval digest) hashes it the
  // same way. Passing the raw id here threw INVALID_ARGUMENT before it ever reached the chain.
  const tx = await treasury.redeemClaim(toOnchainId(claim.awardId), { gasLimit: GAS_LIMITS.redeemClaim });
  const receipt = await tx.wait();
  const txHash = receipt?.hash ?? tx.hash;

  await store.upsertPrizeClaim(c.env.DB, { ...claim, status: "redeemed", redeemedTxHash: txHash });
  // The contract moves the award to Redeemed here too; mirror it or the award is left reading
  // "claim_minted" forever, next to a claim that says redeemed.
  await store.updateAwardProposal(c.env.DB, { id: claim.awardId, status: "redeemed", txHash });
  await store.recordEvent(c.env.DB, {
    scope: "claim",
    source: "chain",
    type: "claim.redeemed",
    actor: user.accountId,
    hackathonId: null,
    submissionId: null,
    awardId: claim.awardId,
    claimId: claim.id,
    txHash,
    payload: { explorer: hashScan.tx(c.env.HEDERA_NETWORK, txHash) },
  });

  return c.json({ ok: true, txHash, explorer: hashScan.tx(c.env.HEDERA_NETWORK, txHash) });
});

// ── observability ───────────────────────────────────────────────────────────

api.get("/jobs", async (c) => c.json(await store.listJobs(c.env.DB)));

api.get("/events", async (c) => {
  const hackathonId = c.req.query("h") ?? undefined;
  return c.json(await store.listEvents(c.env.DB, { hackathonId }));
});

// ── worker ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();
app.route("/api", api);
// Everything else is the SPA. `not_found_handling: single-page-application` in wrangler.jsonc
// makes deep links like /hackathon/live resolve to index.html instead of 404.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  /**
   * Cron replacement for the old `for(;;)` worker loop. Requeues abandoned jobs first — a Worker
   * killed mid-job used to leave it 'running' forever — then drains a bounded number of jobs so
   * a single invocation cannot run away.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const requeued = await store.reapExpiredLeases(env.DB);
        if (requeued) console.log(`[cron] requeued ${requeued} abandoned job(s)`);
        await pruneNonces(env.DB);

        const budget = jobsPerCron(env);
        for (let i = 0; i < budget; i++) {
          const job = await store.claimNextJob(env.DB, "judgebuddy-cron");
          if (!job) break;
          try {
            const result = await handleJob(env, job as never);
            if (result.ok) {
              await store.completeJob(env.DB, job.id);
              console.log(`[cron] ${job.type} ${job.id}: ${result.note}`);
            } else {
              await store.failJob(env.DB, job.id, result.note);
              console.warn(`[cron] ${job.type} ${job.id} failed: ${result.note}`);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await store.failJob(env.DB, job.id, message);
            console.error(`[cron] ${job.type} ${job.id} threw: ${message}`);
          }
        }
      })(),
    );
  },
};
