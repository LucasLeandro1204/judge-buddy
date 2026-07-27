/**
 * The agent pipeline, as a chain of small jobs.
 *
 * worker/src/analysis.ts did all of this inside one `evaluateSubmission` call: three model
 * requests, then four sequential on-chain transactions each awaiting a receipt. That shape is
 * wrong for Workers — a single invocation that dies partway leaves the submission in an
 * unrecoverable half-state, and the original code had no retry and no lease reaper.
 *
 * Here each step is its own job. A step does its work, records what happened, and enqueues the
 * next one. If a step fails it retries with backoff (cf/src/db/store.ts failJob) without redoing
 * the steps that already succeeded, and every step is idempotent enough to survive a re-run.
 *
 *   evaluate_submission  agents score the submission              (no chain writes)
 *   anchor_evaluation    registerSubmission + recordEvaluation    (evidence hash on-chain)
 *   propose_award        proposeAward                             (award exists on-chain)
 *   settle_autonomous    executeAutonomousPayout                  (below the ceiling only)
 */
import { id as toOnchainId } from "ethers";
import type { Env } from "../lib/env.js";
import { canWriteChain } from "../lib/env.js";
import { GAS_LIMITS, getTreasuryWrite, hashEvidence } from "../lib/hedera.js";
import { runEligibility } from "./evidence.js";
import { runConverge, runQuality, runTrackFit } from "./score.js";
import * as store from "../db/store.js";

type JobHandlerResult = { ok: true; note: string } | { ok: false; note: string };

/** Chain writes are opportunistic: with no relayer configured the pipeline still scores. */
function chainConfigured(env: Env, step: string): boolean {
  if (canWriteChain(env)) return true;
  console.log(`[pipeline] skipping ${step}: treasury address or relayer key not configured`);
  return false;
}

/**
 * Folds the hydrated evaluation runs into `{ eligibility, track-fit, quality }`.
 * This object is what gets keccak-hashed and written on-chain, so its shape is what a builder
 * would later hash to check the rationale they were given.
 */
function collectEvaluation(submission: { evaluationRuns: Array<{ agentRole: string; result: unknown }> }) {
  return Object.fromEntries(submission.evaluationRuns.map((run) => [run.agentRole, run.result])) as Record<
    string,
    unknown
  >;
}

async function loadContext(env: Env, submissionId: string) {
  const submission = await store.getSubmission(env.DB, submissionId);
  if (!submission) throw new Error(`Submission ${submissionId} not found`);
  const hackathon = await store.getHackathon(env.DB, submission.hackathonId);
  if (!hackathon) throw new Error(`Hackathon ${submission.hackathonId} not found`);
  const track = hackathon.tracks.find((entry) => entry.id === submission.trackId);
  if (!track) throw new Error(`Track ${submission.trackId} not found`);
  return { submission, hackathon, track };
}

// ── step 1: score ───────────────────────────────────────────────────────────

export async function evaluateSubmission(env: Env, submissionId: string): Promise<JobHandlerResult> {
  const { submission, hackathon, track } = await loadContext(env, submissionId);
  const policy = (track.evaluationPolicy ?? {}) as Record<string, unknown>;

  const { result: eligibility, repo } = await runEligibility(policy as never, submission, env.GITHUB_TOKEN);
  await store.replaceLatestEvaluationRun(env.DB, {
    submissionId,
    agentRole: "eligibility",
    status: "completed",
    result: eligibility as unknown as Record<string, unknown>,
  });
  await store.recordEvent(env.DB, {
    scope: "submission",
    source: "worker",
    type: "eligibility.completed",
    actor: "sentinel-agent",
    hackathonId: hackathon.id,
    submissionId,
    awardId: null,
    claimId: null,
    txHash: null,
    payload: eligibility as unknown as Record<string, unknown>,
  });

  // An unverifiable check is not a failed check. Throwing sends the job back through failJob's
  // retry-with-backoff instead of branding a real submission ineligible on a rate-limit blip.
  if (eligibility.indeterminate) {
    await store.updateSubmissionStatus(env.DB, submissionId, "pending");
    throw new Error(`evidence incomplete, retrying: ${eligibility.notes}`);
  }

  if (!eligibility.passed) {
    await store.updateSubmissionStatus(env.DB, submissionId, "ineligible");
    return { ok: true, note: `ineligible: ${eligibility.notes}` };
  }

  const trackFit = await runTrackFit(env, track as never, submission as never);
  await store.replaceLatestEvaluationRun(env.DB, {
    submissionId,
    agentRole: "track-fit",
    status: "completed",
    result: trackFit.result as unknown as Record<string, unknown>,
    model: trackFit.model,
  });

  const quality = await runQuality(env, track as never, submission as never, eligibility, repo);
  await store.replaceLatestEvaluationRun(env.DB, {
    submissionId,
    agentRole: "quality",
    status: "completed",
    result: quality.result as unknown as Record<string, unknown>,
    model: quality.model,
  });

  await store.updateSubmissionStatus(env.DB, submissionId, "evaluated");
  await store.recordEvent(env.DB, {
    scope: "submission",
    source: "worker",
    type: "quality.completed",
    actor: "oracle-agent",
    hackathonId: hackathon.id,
    submissionId,
    awardId: null,
    claimId: null,
    txHash: null,
    payload: { trackFit: trackFit.result, quality: quality.result },
  });

  await store.enqueueJob(env.DB, "anchor_evaluation", { submissionId });
  // Re-cluster now that another submission has been scored. Replacing is idempotent, so a
  // duplicate enqueue is harmless.
  await store.enqueueJob(env.DB, "cluster_submissions", { hackathonId: hackathon.id });
  return { ok: true, note: `scored ${quality.result.score}/100 (model: ${quality.model ?? "deterministic"})` };
}

// ── step 2: anchor the evidence on-chain ────────────────────────────────────

export async function anchorEvaluation(env: Env, submissionId: string): Promise<JobHandlerResult> {
  const { submission, hackathon, track } = await loadContext(env, submissionId);

  const evaluation = collectEvaluation(submission);
  const quality = (evaluation["quality"] ?? {}) as { score?: number };
  const score = Math.max(0, Math.min(100, Math.round(Number(quality.score ?? 0))));

  if (!chainConfigured(env, "anchor_evaluation")) {
    await store.enqueueJob(env.DB, "propose_award", { submissionId });
    return { ok: true, note: "chain not configured; anchoring skipped" };
  }

  const treasury = getTreasuryWrite(env);
  const submissionOnchainId = toOnchainId(submission.id);
  const evidenceHash = hashEvidence(evaluation);

  // registerSubmission is not idempotent on-chain but overwrites the same slot, so a retry is
  // harmless. recordEvaluation only emits.
  const registerTx = await treasury.registerSubmission(
    submissionOnchainId,
    toOnchainId(hackathon.id),
    toOnchainId(track.id),
    submission.payoutEvmAddress,
    hashEvidence(submission.githubUrl),
    { gasLimit: GAS_LIMITS.registerSubmission },
  );
  await registerTx.wait();

  const evaluationTx = await treasury.recordEvaluation(submissionOnchainId, true, score, evidenceHash, {
    gasLimit: GAS_LIMITS.recordEvaluation,
  });
  const receipt = await evaluationTx.wait();

  await store.recordEvent(env.DB, {
    scope: "submission",
    source: "chain",
    type: "evaluation.anchored",
    actor: "treasury-agent",
    hackathonId: hackathon.id,
    submissionId,
    awardId: null,
    claimId: null,
    txHash: receipt?.hash ?? evaluationTx.hash,
    payload: { evidenceHash, score },
  });

  await store.enqueueJob(env.DB, "propose_award", { submissionId });
  return { ok: true, note: `anchored evidence ${evidenceHash.slice(0, 18)}… at ${receipt?.hash ?? evaluationTx.hash}` };
}

// ── step 3: propose the award ───────────────────────────────────────────────

export async function proposeAward(env: Env, submissionId: string): Promise<JobHandlerResult> {
  const { submission, hackathon, track } = await loadContext(env, submissionId);

  const evaluation = collectEvaluation(submission);
  const quality = (evaluation["quality"] ?? {}) as { score?: number; reasoning?: string };
  const score = Number(quality.score ?? 0);

  // Idempotency guard. A retried or manually re-queued anchor step re-enters this job, and
  // without this each pass creates another award row for the same submission. The contract
  // refuses to pay twice, so the duplicate never costs money — but it does show up in the UI as
  // a phantom second award, which is exactly the kind of thing a reviewer would notice.
  if (submission.awardProposal) {
    return { ok: true, note: `award ${submission.awardProposal.id} already exists for this submission` };
  }

  const minimum = Number((track.evaluationPolicy as Record<string, unknown>)?.minQualityScore ?? 0);
  if (score < minimum) {
    return { ok: true, note: `score ${score} is below the track minimum ${minimum}; no award proposed` };
  }

  // The routing decision the whole product turns on.
  const withinCeiling = BigInt(track.prizeAmount) <= BigInt(hackathon.autonomousThreshold);
  const settlementMode = withinCeiling ? "autonomous_payout" : "claim_token";

  const award = await store.createAwardProposal(env.DB, {
    hackathonId: hackathon.id,
    submissionId,
    trackId: track.id,
    winnerAccountId: submission.payoutAccountId,
    winnerEvmAddress: submission.payoutEvmAddress,
    amount: track.prizeAmount,
    settlementMode,
    status: withinCeiling ? "recommended" : "awaiting_approval",
    reason: quality.reasoning ?? "No rationale recorded.",
    machinePolicy: evaluation as Record<string, unknown>,
  });

  await store.recordEvent(env.DB, {
    scope: "award",
    source: "worker",
    type: "award.recommended",
    actor: "treasury-agent",
    hackathonId: hackathon.id,
    submissionId,
    awardId: award.id,
    claimId: null,
    txHash: null,
    payload: { amount: track.prizeAmount, settlementMode, withinCeiling },
  });

  if (!chainConfigured(env, "propose_award")) {
    return { ok: true, note: `award ${award.id} recorded off-chain only` };
  }

  const treasury = getTreasuryWrite(env);
  const proposalTx = await treasury.proposeAward(
    toOnchainId(award.id),
    toOnchainId(submissionId),
    submission.payoutEvmAddress,
    track.prizeAmount,
    withinCeiling ? 0 : 1,
    hashEvidence(quality.reasoning ?? ""),
    { gasLimit: GAS_LIMITS.proposeAward },
  );
  const receipt = await proposalTx.wait();
  await store.updateAwardProposal(env.DB, { id: award.id, txHash: receipt?.hash ?? proposalTx.hash });

  if (withinCeiling) {
    await store.enqueueJob(env.DB, "settle_autonomous", { awardId: award.id });
    return { ok: true, note: `award ${award.id} proposed on-chain; queued for autonomous settlement` };
  }

  // Above the ceiling the contract will not release funds without a judge signature, so the
  // approval request is created and the pipeline stops here on purpose.
  await store.enqueueJob(env.DB, "request_approval", { awardId: award.id });
  return { ok: true, note: `award ${award.id} exceeds the autonomy ceiling; awaiting judge approval` };
}

// ── step 4: settle below the ceiling ────────────────────────────────────────

export async function settleAutonomous(env: Env, awardId: string): Promise<JobHandlerResult> {
  const award = await store.getAwardProposal(env.DB, awardId);
  if (!award) throw new Error(`Award ${awardId} not found`);
  if (award.status === "paid_out") return { ok: true, note: "already settled" };

  if (!chainConfigured(env, "settle_autonomous")) {
    return { ok: false, note: "cannot settle without a configured treasury and relayer" };
  }

  const treasury = getTreasuryWrite(env);
  const payoutTx = await treasury.executeAutonomousPayout(toOnchainId(awardId), {
    gasLimit: GAS_LIMITS.executeAutonomousPayout,
  });
  const receipt = await payoutTx.wait();
  const txHash = receipt?.hash ?? payoutTx.hash;

  await store.updateAwardProposal(env.DB, { id: awardId, status: "paid_out", txHash });
  await store.updateSubmissionStatus(env.DB, award.submissionId, "paid");
  await store.recordEvent(env.DB, {
    scope: "award",
    source: "chain",
    type: "award.autonomous_paid",
    actor: "treasury-agent",
    hackathonId: award.hackathonId,
    submissionId: award.submissionId,
    awardId,
    claimId: null,
    txHash,
    payload: { amount: award.amount },
  });

  return { ok: true, note: `paid ${award.amount} at ${txHash}` };
}

// ── grouping ────────────────────────────────────────────────────────────────

/**
 * Runs Converge and persists the result. Kept out of the request path deliberately: computing
 * this inside GET /hackathons/:id made every page view wait 8-9 seconds on a model call.
 */
export async function clusterSubmissions(env: Env, hackathonId: string): Promise<JobHandlerResult> {
  const submissions = await store.listSubmissions(env.DB, hackathonId);
  const eligible = submissions.filter((entry) => entry.status !== "ineligible");

  if (eligible.length < 2) {
    await store.replaceSimilarityClusters(env.DB, hackathonId, []);
    return { ok: true, note: "fewer than two eligible submissions; nothing to cluster" };
  }

  const converge = await runConverge(
    env,
    eligible.map((entry) => ({ id: entry.id, projectName: entry.projectName, description: entry.description })),
  );

  // No result means the agent did not run. Persist nothing rather than a fabricated grouping —
  // the UI then groups by track and says so.
  if (!converge) {
    await store.replaceSimilarityClusters(env.DB, hackathonId, []);
    return { ok: true, note: "similarity agent unavailable; no clustering recorded" };
  }

  const clusteredAt = new Date().toISOString();
  await store.replaceSimilarityClusters(
    env.DB,
    hackathonId,
    converge.result.map((group, index) => ({
      id: `cluster-${hackathonId}-${index}`,
      label: group.theme,
      theme: group.theme,
      agentRationale: group.rationale,
      agentId: "converge",
      method: "llm",
      model: converge.model ?? "unknown",
      keywords: [],
      cohesion: null,
      submissionIds: group.members,
      clusteredAt,
    })),
  );

  return { ok: true, note: `clustered ${eligible.length} submissions into ${converge.result.length} themes` };
}

// ── dispatcher ──────────────────────────────────────────────────────────────

export async function handleJob(
  env: Env,
  job: { id: string; type: string; payload: Record<string, unknown> },
): Promise<JobHandlerResult> {
  const submissionId = String(job.payload.submissionId ?? "");
  const awardId = String(job.payload.awardId ?? "");

  switch (job.type) {
    case "evaluate_submission":
      return evaluateSubmission(env, submissionId);
    case "anchor_evaluation":
      return anchorEvaluation(env, submissionId);
    case "propose_award":
      return proposeAward(env, submissionId);
    case "settle_autonomous":
      return settleAutonomous(env, awardId);
    case "cluster_submissions":
      return clusterSubmissions(env, String(job.payload.hackathonId ?? ""));
    case "request_approval":
      // Approval requests are built in the API layer where the EIP-712 domain and the
      // clear-signing manifest live; nothing to do on the worker side.
      return { ok: true, note: "approval request handled by the API layer" };
    default:
      return { ok: false, note: `unknown job type ${job.type}` };
  }
}
