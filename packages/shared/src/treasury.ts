import { TypedDataEncoder, type TypedDataField } from "ethers";
import { z } from "zod";
import { makeId } from "./ids.js";

export const settlementModeSchema = z.enum(["autonomous_payout", "claim_token"]);
export type SettlementMode = z.infer<typeof settlementModeSchema>;

export const sponsorPolicySchema = z.object({
  minQualityScore: z.number().int().min(0).max(100).default(70),
  requiresPublicRepo: z.boolean().default(true),
  requiresReadme: z.boolean().default(true),
  requiresDemo: z.boolean().default(true),
  requiresHashscanVerification: z.boolean().default(false),
  requiresContracts: z.boolean().default(false),
});

export const trackSchema = z.object({
  id: z.string().min(1).default(() => makeId("track")),
  name: z.string().min(1),
  description: z.string().min(1),
  sponsorName: z.string().min(1),
  prizeAmount: z.string().regex(/^\d+$/),
  requirements: z.array(z.string().min(1)).min(1),
  evaluationPolicy: sponsorPolicySchema,
});
export type Track = z.infer<typeof trackSchema>;

export const createHackathonRequestSchema = z.object({
  name: z.string().min(1),
  tagline: z.string().min(1),
  organizerAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  organizerEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  judgeAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  judgeEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  payoutTokenId: z.string().regex(/^\d+\.\d+\.\d+$/),
  payoutTokenEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  autonomousThreshold: z.string().regex(/^\d+$/),
  approvalExpirySeconds: z.number().int().min(60).max(60 * 60 * 24 * 30).default(60 * 60 * 24 * 7),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  submissionDeadline: z.string().datetime(),
  judgingEndsAt: z.string().datetime(),
  tracks: z.array(trackSchema).min(1),
});
export type CreateHackathonRequest = z.infer<typeof createHackathonRequestSchema>;

export const fundHackathonRequestSchema = z.object({
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});
export type FundHackathonRequest = z.infer<typeof fundHackathonRequestSchema>;

export const submissionContractSchema = z.object({
  label: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  hashscanUrl: z.string().url().optional(),
});

export const createSubmissionRequestSchema = z.object({
  hackathonId: z.string().min(1),
  trackId: z.string().min(1),
  projectName: z.string().min(1),
  teamName: z.string().min(1),
  teamMembers: z.array(z.string().min(1)).default([]),
  githubUrl: z.string().url(),
  demoUrl: z.string().url(),
  description: z.string().min(1),
  payoutAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  payoutEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  deployedContracts: z.array(submissionContractSchema).default([]),
});
export type CreateSubmissionRequest = z.infer<typeof createSubmissionRequestSchema>;

export const queueEvaluationRequestSchema = z.object({
  submissionId: z.string().min(1),
  force: z.boolean().default(false),
});

export const awardApprovalSchema = z.object({
  awardId: z.string().min(1),
  hackathonId: z.string().min(1),
  submissionId: z.string().min(1),
  trackId: z.string().min(1),
  winner: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+$/),
  settlementMode: settlementModeSchema,
  expiresAt: z.number().int().positive(),
});
export type AwardApproval = z.infer<typeof awardApprovalSchema>;

export const awardApprovalTypes: Record<string, TypedDataField[]> = {
  AwardApproval: [
    { name: "awardId", type: "bytes32" },
    { name: "hackathonId", type: "bytes32" },
    { name: "submissionId", type: "bytes32" },
    { name: "trackId", type: "bytes32" },
    { name: "winner", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "settlementMode", type: "uint8" },
    { name: "expiresAt", type: "uint256" },
  ],
};

export function buildAwardApprovalTypedData(input: {
  chainId: number;
  verifyingContract: string;
  approval: {
    awardId: `0x${string}`;
    hackathonId: `0x${string}`;
    submissionId: `0x${string}`;
    trackId: `0x${string}`;
    winner: string;
    amount: string;
    settlementMode: SettlementMode;
    expiresAt: number;
  };
}) {
  const value = {
    awardId: input.approval.awardId,
    hackathonId: input.approval.hackathonId,
    submissionId: input.approval.submissionId,
    trackId: input.approval.trackId,
    winner: input.approval.winner,
    amount: input.approval.amount,
    settlementMode: input.approval.settlementMode === "claim_token" ? 1 : 0,
    expiresAt: String(input.approval.expiresAt),
  };

  const domain = {
    name: "JudgeBuddyTreasury",
    version: "1",
    chainId: input.chainId,
    verifyingContract: input.verifyingContract,
  };

  return {
    domain,
    types: awardApprovalTypes,
    primaryType: "AwardApproval" as const,
    value,
    digest: TypedDataEncoder.hash(domain, awardApprovalTypes, value),
  };
}

export const approveAwardRequestSchema = z.object({
  approval: awardApprovalSchema,
  signature: z.string().min(1),
});
export type ApproveAwardRequest = z.infer<typeof approveAwardRequestSchema>;

export const redeemClaimRequestSchema = z.object({
  claimId: z.string().min(1),
});

export const evaluationRunSchema = z.object({
  id: z.string(),
  submissionId: z.string(),
  agentRole: z.enum(["eligibility", "track-fit", "quality", "treasury", "policy-explainer"]),
  status: z.enum(["queued", "running", "completed", "failed"]),
  result: z.record(z.any()).nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type EvaluationRun = z.infer<typeof evaluationRunSchema>;

export const awardProposalSchema = z.object({
  id: z.string(),
  hackathonId: z.string(),
  submissionId: z.string(),
  trackId: z.string(),
  winnerAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  winnerEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+$/),
  settlementMode: settlementModeSchema,
  status: z.enum([
    "recommended",
    "awaiting_approval",
    "approved",
    "claim_minted",
    "redeemed",
    "paid_out",
    "failed",
  ]),
  reason: z.string(),
  machinePolicy: z.record(z.any()),
  digest: z.string().nullable(),
  txHash: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AwardProposal = z.infer<typeof awardProposalSchema>;

export const approvalRequestSchema = z.object({
  id: z.string(),
  awardId: z.string(),
  actionType: z.enum(["approve_award", "mint_claim", "release_payout", "refund_payout"]),
  signerAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  signerEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  status: z.enum(["pending", "approved", "executed", "failed", "expired"]),
  typedData: z.record(z.any()),
  clearSigningManifest: z.record(z.any()),
  signature: z.string().nullable(),
  expiresAt: z.string(),
  approvedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const prizeClaimSchema = z.object({
  id: z.string(),
  awardId: z.string(),
  claimantAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  claimantEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenAddress: z.string().nullable(),
  serialNumber: z.string().nullable(),
  metadataURI: z.string().nullable(),
  status: z.enum(["pending", "minted", "redeemed", "failed"]),
  mintedTxHash: z.string().nullable(),
  redeemedTxHash: z.string().nullable(),
});
export type PrizeClaim = z.infer<typeof prizeClaimSchema>;

export const eventEnvelopeSchema = z.object({
  id: z.string(),
  scope: z.enum(["hackathon", "submission", "award", "claim", "job", "system"]),
  source: z.enum(["api", "worker", "chain", "hcs", "naryo"]),
  type: z.string(),
  actor: z.string().nullable(),
  hackathonId: z.string().nullable(),
  submissionId: z.string().nullable(),
  awardId: z.string().nullable(),
  claimId: z.string().nullable(),
  txHash: z.string().nullable(),
  hcsTxId: z.string().nullable().optional(),
  hcsTopicId: z.string().nullable().optional(),
  hcsSequenceNumber: z.string().nullable().optional(),
  payload: z.record(z.any()),
  createdAt: z.string(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const hackathonRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  organizerAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  organizerEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  judgeAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  judgeEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  payoutTokenId: z.string().regex(/^\d+\.\d+\.\d+$/),
  payoutTokenEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  autonomousThreshold: z.string().regex(/^\d+$/),
  approvalExpirySeconds: z.number().int().positive(),
  startsAt: z.string(),
  endsAt: z.string(),
  submissionDeadline: z.string(),
  judgingEndsAt: z.string(),
  status: z.enum(["draft", "funding", "live", "judging", "completed"]),
  treasuryTxHash: z.string().nullable(),
  tracks: z.array(trackSchema),
});
export type HackathonRecord = z.infer<typeof hackathonRecordSchema>;

export const similarityClusterSchema = z.object({
  id: z.string(),
  label: z.string(),
  theme: z.string(),
  agentRationale: z.string(),
  agentId: z.string(),
  // "llm" covers grouping produced by a language model reasoning over the submissions, which is
  // what the Converge agent does on Workers AI. Kept distinct from "embeddings" so the UI never
  // claims a vector-similarity provenance the run did not actually have.
  method: z.enum(["embeddings", "lexical", "llm"]),
  model: z.string(),
  keywords: z.array(z.string()).default([]),
  cohesion: z.number().min(0).max(1).nullable().default(null),
  clusteredAt: z.string(),
  submissionIds: z.array(z.string()).default([]),
});
export type SimilarityCluster = z.infer<typeof similarityClusterSchema>;

export const submissionRecordSchema = z.object({
  id: z.string(),
  hackathonId: z.string(),
  trackId: z.string(),
  projectName: z.string(),
  teamName: z.string(),
  teamMembers: z.array(z.string()),
  githubUrl: z.string().url(),
  demoUrl: z.string().url(),
  description: z.string(),
  payoutAccountId: z.string().regex(/^\d+\.\d+\.\d+$/),
  payoutEvmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  deployedContracts: z.array(submissionContractSchema),
  status: z.enum(["pending", "eligible", "ineligible", "evaluated", "awarded", "paid"]),
  evaluationRuns: z.array(evaluationRunSchema).default([]),
  awardProposal: awardProposalSchema.nullable().default(null),
  claim: prizeClaimSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SubmissionRecord = z.infer<typeof submissionRecordSchema>;
