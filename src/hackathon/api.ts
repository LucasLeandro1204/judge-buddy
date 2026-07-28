import type { AuthenticatedUser } from "@shared/auth";
import type {
  ApprovalRequest,
  ApproveAwardRequest,
  AwardProposal,
  CreateHackathonRequest,
  CreateSubmissionRequest,
  EventEnvelope,
  HackathonRecord,
  PrizeClaim,
  SimilarityCluster,
  SubmissionRecord,
} from "@shared/treasury";
import { HEDERA_API_URL } from "@/contracts/env";

export type HackathonDetail = HackathonRecord & {
  submissions: SubmissionRecord[];
  approvals: ApprovalRequest[];
  claims: PrizeClaim[];
  similarityClusters: SimilarityCluster[];
};

export type HealthResponse = {
  ok: boolean;
  network: string;
  mirrorBase: string;
  hederaEvmRpc: string;
  treasuryContractConfigured: boolean;
  prizeClaimTokenConfigured: boolean;
  chain?: {
    canWrite: boolean;
    treasuryContractAddress: string | null;
    prizeClaimTokenAddress: string | null;
    payoutTokenAddress: string | null;
    payoutTokenSymbol: string | null;
    payoutTokenDecimals: number | null;
    explorer: string | null;
  };
};

export type JobRecord = {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
};

export type SessionResponse = {
  authenticated: boolean;
  user?: AuthenticatedUser;
};

export const TREASURY_BROWSER_CONTRACT_ADDRESS =
  (import.meta.env.VITE_TREASURY_CONTRACT_ADDRESS as string | undefined)?.trim() ?? "";
export const PRIZE_CLAIM_BROWSER_TOKEN_ADDRESS =
  (import.meta.env.VITE_PRIZE_CLAIM_TOKEN_ADDRESS as string | undefined)?.trim() ?? "";

/**
 * The API base always resolves: `VITE_HEDERA_API_URL` when set (local dev against a
 * separate API process), otherwise the same-origin `/api` mount that the production
 * Worker serves. Nothing here throws for missing configuration.
 */
export function apiBaseUrl(): string {
  return HEDERA_API_URL;
}

export function isApiConfigured(): boolean {
  return true;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>("/health", { method: "GET" });
}

export function fetchHackathons(): Promise<HackathonRecord[]> {
  return apiRequest<HackathonRecord[]>("/hackathons", { method: "GET" });
}

export function fetchHackathon(id: string): Promise<HackathonDetail> {
  return apiRequest<HackathonDetail>(`/hackathons/${encodeURIComponent(id)}`, { method: "GET" });
}

export function createHackathon(payload: CreateHackathonRequest): Promise<HackathonRecord> {
  return apiRequest<HackathonRecord>("/hackathons", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function confirmHackathonFunding(hackathonId: string, txHash: string): Promise<{ ok: true; txHash: string }> {
  return apiRequest<{ ok: true; txHash: string }>(`/hackathons/${encodeURIComponent(hackathonId)}/fund`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
}

export function createSubmission(payload: CreateSubmissionRequest): Promise<{ submission: SubmissionRecord; jobId: string }> {
  return apiRequest<{ submission: SubmissionRecord; jobId: string }>("/submissions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchSubmissions(hackathonId: string): Promise<SubmissionRecord[]> {
  return apiRequest<SubmissionRecord[]>(`/submissions?h=${encodeURIComponent(hackathonId)}`, { method: "GET" });
}

export function fetchSubmission(id: string): Promise<SubmissionRecord> {
  return apiRequest<SubmissionRecord>(`/submissions/${encodeURIComponent(id)}`, { method: "GET" });
}

export function queueEvaluation(submissionId: string, force = false): Promise<{ ok: true; jobId: string }> {
  return apiRequest<{ ok: true; jobId: string }>(`/submissions/${encodeURIComponent(submissionId)}/evaluate`, {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

export function fetchApprovals(hackathonId?: string): Promise<ApprovalRequest[]> {
  const query = hackathonId ? `?h=${encodeURIComponent(hackathonId)}` : "";
  return apiRequest<ApprovalRequest[]>(`/approvals${query}`, { method: "GET" });
}

export function approveAward(awardId: string, payload: ApproveAwardRequest): Promise<{ ok: true; txHash: string; status: string }> {
  return apiRequest<{ ok: true; txHash: string; status: string }>(`/awards/${encodeURIComponent(awardId)}/approve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchClaims(hackathonId?: string): Promise<PrizeClaim[]> {
  const query = hackathonId ? `?h=${encodeURIComponent(hackathonId)}` : "";
  return apiRequest<PrizeClaim[]>(`/claims${query}`, { method: "GET" });
}

export function redeemClaim(claimId: string): Promise<{ ok: true; txHash: string }> {
  return apiRequest<{ ok: true; txHash: string }>(`/claims/${encodeURIComponent(claimId)}/redeem`, {
    method: "POST",
  });
}

export function fetchJobs(): Promise<JobRecord[]> {
  return apiRequest<JobRecord[]>("/jobs", { method: "GET" });
}

export function fetchEvents(params?: {
  hackathonId?: string;
  submissionId?: string;
  scope?: EventEnvelope["scope"];
}): Promise<EventEnvelope[]> {
  const search = new URLSearchParams();
  if (params?.hackathonId) search.set("h", params.hackathonId);
  if (params?.submissionId) search.set("s", params.submissionId);
  if (params?.scope) search.set("scope", params.scope);
  const query = search.toString();
  return apiRequest<EventEnvelope[]>(`/events${query ? `?${query}` : ""}`, { method: "GET" });
}

export function findAwardForApproval(approval: ApprovalRequest, awards: AwardProposal[]): AwardProposal | null {
  return awards.find((award) => award.id === approval.awardId) ?? null;
}
