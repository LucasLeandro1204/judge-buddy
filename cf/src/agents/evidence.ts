/**
 * Evidence gathering — the part of the pipeline that is not a language model.
 *
 * Every check here hits a real external service: the GitHub REST API for repository facts, the
 * submitted demo URL, and HashScan for each declared contract. A model is never asked whether a
 * repository is public or a demo is reachable, because a model cannot know. Ported from
 * worker/src/analysis.ts with the fetch calls unchanged in behaviour.
 */

/**
 * "indeterminate" is the important one. GitHub's unauthenticated API allows 60 requests per hour
 * per IP, and Workers egress from shared Cloudflare addresses, so that budget disappears fast.
 * The first version of this code folded a rate-limited response into `publicRepo: false`, which
 * silently converted "we could not check" into "this applicant failed" and rejected real,
 * public repositories. A check that could not run must never read as a failed rule.
 */
export type RepoLookupStatus = "public" | "private_or_missing" | "indeterminate";

export type RepoEvidence = {
  status: RepoLookupStatus;
  publicRepo: boolean;
  defaultBranch: string | null;
  readmePresent: boolean;
  topics: string[];
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  pushedAt: string | null;
  lookupError: string | null;
};

export type EligibilityResult = {
  passed: boolean;
  /** True when a required check could not be completed. The caller must retry, not reject. */
  indeterminate: boolean;
  githubLive: boolean;
  demoPresent: boolean;
  readmePresent: boolean;
  hashscanVerified: boolean;
  rulesMet: boolean;
  notes: string;
};

export type TrackFitResult = { fit: "high" | "medium" | "low"; flags: string[]; reasoning: string };

export type QualityResult = { score: number; reasoning: string; highlights: string[]; concerns: string[] };

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "JudgeBuddy-Worker",
    Accept: "application/vnd.github+json",
  };
  // Optional GITHUB_TOKEN secret lifts the limit from 60 req/hour to 5000. Without it the
  // pipeline still works, it just marks more lookups indeterminate under load.
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Workers have a wall-clock budget; a hanging third party must not take the whole job with it. */
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function emptyRepoEvidence(status: RepoLookupStatus, lookupError: string | null = null): RepoEvidence {
  return {
    status,
    publicRepo: false,
    defaultBranch: null,
    readmePresent: false,
    topics: [],
    stars: 0,
    forks: 0,
    openIssues: 0,
    language: null,
    pushedAt: null,
    lookupError,
  };
}

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

/** Distinguishes "not there" (404) from "could not ask" (403/429/5xx/network). */
type Probe<T> = { kind: "ok"; value: T } | { kind: "absent" } | { kind: "unknown"; reason: string };

async function probe<T>(url: string, token?: string): Promise<Probe<T>> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { headers: githubHeaders(token) });
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : "network error" };
  }
  if (response.ok) return { kind: "ok", value: (await response.json()) as T };
  if (response.status === 404) return { kind: "absent" };
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    return { kind: "unknown", reason: remaining === "0" ? "github rate limit exhausted" : `github ${response.status}` };
  }
  return { kind: "unknown", reason: `github ${response.status}` };
}

/**
 * Rate-limit-free fallback.
 *
 * api.github.com allows 60 requests/hour per IP unauthenticated, and Cloudflare Workers egress
 * from shared addresses, so that budget is routinely already spent by someone else. github.com
 * and raw.githubusercontent.com are ordinary web endpoints without that quota, and they answer
 * the only two questions the eligibility rules actually ask: is the repository publicly
 * reachable, and does it have a README. Less metadata than the API, but a real answer instead of
 * an indeterminate one.
 */
async function collectRepoEvidenceViaWeb(owner: string, repo: string): Promise<RepoEvidence> {
  let repoReachable: boolean;
  try {
    const response = await fetchWithTimeout(`https://github.com/${owner}/${repo}`, {
      method: "GET",
      redirect: "follow",
    });
    if (response.status === 404) return emptyRepoEvidence("private_or_missing", "repository not found (web)");
    repoReachable = response.ok;
  } catch (error) {
    return emptyRepoEvidence("indeterminate", `web fallback: ${error instanceof Error ? error.message : "failed"}`);
  }
  if (!repoReachable) return emptyRepoEvidence("indeterminate", "web fallback: unexpected status");

  let readmePresent = false;
  try {
    const readme = await fetchWithTimeout(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`, {
      method: "GET",
      redirect: "follow",
    });
    readmePresent = readme.ok;
  } catch {
    readmePresent = false;
  }

  return {
    status: "public",
    publicRepo: true,
    defaultBranch: null,
    readmePresent,
    topics: [],
    stars: 0,
    forks: 0,
    openIssues: 0,
    language: null,
    pushedAt: null,
    // Recorded so the rationale can say the richer API data was not available for this run.
    lookupError: "github api unavailable; verified via public web endpoints",
  };
}

export async function collectRepoEvidence(githubUrl: string, token?: string): Promise<RepoEvidence> {
  const slug = parseGitHubRepo(githubUrl);
  // A URL that is not a GitHub repo at all is a genuine finding, not a failed lookup.
  if (!slug) return emptyRepoEvidence("private_or_missing", "not a github repository url");

  const repoProbe = await probe<Record<string, unknown>>(
    `https://api.github.com/repos/${slug.owner}/${slug.repo}`,
    token,
  );
  if (repoProbe.kind === "absent") return emptyRepoEvidence("private_or_missing", "repository not found");
  // Do not give up on a rate limit — fall back to endpoints that have no API quota.
  if (repoProbe.kind === "unknown") return collectRepoEvidenceViaWeb(slug.owner, slug.repo);

  const repo = repoProbe.value;
  // Only two calls per repository. The old third call listed root contents for a field no rule
  // ever read, which burned a third of a tight rate-limit budget for nothing.
  const readmeProbe = await probe(`https://api.github.com/repos/${slug.owner}/${slug.repo}/readme`, token);

  return {
    status: "public",
    publicRepo: !repo.private,
    defaultBranch: (repo.default_branch as string) ?? null,
    // An indeterminate README lookup is reported as absent but recorded in lookupError, so the
    // rule engine can tell the difference.
    readmePresent: readmeProbe.kind === "ok",
    topics: Array.isArray(repo.topics) ? (repo.topics as string[]) : [],
    stars: Number(repo.stargazers_count ?? 0),
    forks: Number(repo.forks_count ?? 0),
    openIssues: Number(repo.open_issues_count ?? 0),
    language: (repo.language as string) ?? null,
    pushedAt: (repo.pushed_at as string) ?? null,
    lookupError: readmeProbe.kind === "unknown" ? `readme: ${readmeProbe.reason}` : null,
  };
}

/** 401/403/405/429 still prove something is listening, so they count as reachable. */
function isReachable(status: number): boolean {
  return (status >= 200 && status < 400) || [401, 403, 405, 429].includes(status);
}

export async function verifyDemo(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    const head = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" });
    if (isReachable(head.status)) return true;
  } catch {
    // Some hosts reject HEAD outright; fall through to GET.
  }
  try {
    const get = await fetchWithTimeout(url, { method: "GET", redirect: "follow" });
    return isReachable(get.status);
  } catch {
    return false;
  }
}

export async function verifyHashscan(
  contracts: Array<{ hashscanUrl?: string | null }>,
): Promise<boolean> {
  if (!contracts.length) return false;
  const checks = await Promise.all(
    contracts.map(async (contract) => {
      if (!contract.hashscanUrl) return false;
      try {
        const response = await fetchWithTimeout(contract.hashscanUrl, { method: "GET", redirect: "follow" });
        return response.ok;
      } catch {
        return false;
      }
    }),
  );
  return checks.every(Boolean);
}

type Policy = {
  requiresPublicRepo?: boolean;
  requiresReadme?: boolean;
  requiresDemo?: boolean;
  requiresHashscanVerification?: boolean;
  requiresContracts?: boolean;
  minQualityScore?: number;
};

export async function runEligibility(
  policy: Policy,
  submission: { githubUrl: string; demoUrl: string; deployedContracts: Array<{ hashscanUrl?: string | null }> },
  githubToken?: string,
): Promise<{ result: EligibilityResult; repo: RepoEvidence }> {
  const repo = await collectRepoEvidence(submission.githubUrl, githubToken);
  const demoPresent = await verifyDemo(submission.demoUrl);
  const hashscanVerified = policy.requiresHashscanVerification
    ? await verifyHashscan(submission.deployedContracts)
    : true;

  // A rule can only be judged when the evidence for it was actually obtainable.
  const repoUnknown = repo.status === "indeterminate";
  const readmeUnknown = repoUnknown || Boolean(repo.lookupError?.startsWith("readme:"));

  const blockedChecks: string[] = [];
  if (policy.requiresPublicRepo && repoUnknown) blockedChecks.push("public repository");
  if (policy.requiresReadme && readmeUnknown) blockedChecks.push("README");

  const rulesMet =
    (!policy.requiresPublicRepo || repo.publicRepo) &&
    (!policy.requiresReadme || repo.readmePresent) &&
    (!policy.requiresDemo || demoPresent) &&
    (!policy.requiresHashscanVerification || hashscanVerified) &&
    (!policy.requiresContracts || submission.deployedContracts.length > 0);

  const indeterminate = blockedChecks.length > 0;

  const repoNote = {
    public: "Public GitHub repo confirmed.",
    private_or_missing: "Repository is private or unreachable.",
    indeterminate: `Repository status could not be verified (${repo.lookupError ?? "lookup failed"}).`,
  }[repo.status];

  const notes = [
    repoNote,
    readmeUnknown && repo.status === "public" ? "README lookup was rate limited." : repo.readmePresent ? "README found." : "README missing.",
    demoPresent ? "Demo URL responded successfully." : "Demo URL did not resolve.",
    policy.requiresHashscanVerification
      ? hashscanVerified
        ? "HashScan requirements satisfied."
        : "HashScan verification missing."
      : "HashScan verification not required by this track.",
    indeterminate
      ? `Not judged: could not complete the ${blockedChecks.join(" and ")} check. Queued for another attempt.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    // Never report a pass when a required check could not run, and never report a fail either.
    result: {
      passed: !indeterminate && rulesMet,
      indeterminate,
      githubLive: repo.publicRepo,
      demoPresent,
      readmePresent: repo.readmePresent,
      hashscanVerified,
      rulesMet,
      notes,
    },
    repo,
  };
}

// ── deterministic fallbacks ─────────────────────────────────────────────────
// Used when inference is unavailable or returns something unusable. A model outage must degrade
// the sophistication of a score, never stall a live program.

export function heuristicTrackFit(
  track: { requirements: string[] },
  submission: { projectName: string; description: string; githubUrl: string },
): TrackFitResult {
  const haystack = `${submission.projectName}\n${submission.description}\n${submission.githubUrl}`.toLowerCase();
  const hits = track.requirements.filter((requirement) =>
    requirement
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 4)
      .some((term) => haystack.includes(term)),
  );
  const ratio = hits.length / Math.max(track.requirements.length, 1);
  return {
    fit: ratio >= 0.66 ? "high" : ratio >= 0.33 ? "medium" : "low",
    flags: track.requirements.filter((requirement) => !hits.includes(requirement)).slice(0, 3),
    reasoning: hits.length
      ? `Matched ${hits.length} of ${track.requirements.length} stated track requirements by keyword. Deterministic fallback — no model was available.`
      : "No strong overlap with the track requirements. Deterministic fallback — manual review recommended.",
  };
}

export function heuristicQuality(
  policy: Policy,
  submission: { description: string; deployedContracts: unknown[] },
  eligibility: EligibilityResult,
): QualityResult {
  const hasContracts = submission.deployedContracts.length > 0 ? 15 : 0;
  const hasDemo = eligibility.demoPresent ? 20 : 0;
  const hasReadme = eligibility.readmePresent ? 15 : 0;
  const hasRepo = eligibility.githubLive ? 20 : 0;
  const depth = Math.min(Math.floor(submission.description.length / 40), 20);

  return {
    score: Math.min(100, hasContracts + hasDemo + hasReadme + hasRepo + depth),
    reasoning:
      "Deterministic fallback score from repository accessibility, demo availability, README presence and shipped contract artifacts. No model was available for this run.",
    highlights: [
      hasContracts ? "Includes deployed contract artifacts." : null,
      hasDemo ? "Demo URL is reachable." : null,
      hasReadme ? "Repository includes a README." : null,
    ].filter(Boolean) as string[],
    concerns: [
      !hasContracts && policy.requiresContracts ? "Track requires deployed contracts." : null,
      !eligibility.hashscanVerified && policy.requiresHashscanVerification ? "HashScan evidence missing." : null,
    ].filter(Boolean) as string[],
  };
}
