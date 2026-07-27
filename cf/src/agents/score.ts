/**
 * Model-backed scoring on Workers AI.
 *
 * Replaces worker/src/openai.ts. Same contract as before — a strict JSON schema in, a validated
 * object out — but inference runs on the same Cloudflare account the app is deployed to, so
 * there is no third-party API key in the trust boundary.
 *
 * Every call is wrapped: if the model is unavailable, slow, or returns something that does not
 * satisfy the schema, the caller falls back to the deterministic scorers in evidence.ts. That is
 * the property that lets a program keep running through a model outage.
 */
import type { Env } from "../lib/env.js";
import {
  heuristicQuality,
  heuristicTrackFit,
  type EligibilityResult,
  type QualityResult,
  type RepoEvidence,
  type TrackFitResult,
} from "./evidence.js";

type Track = {
  id: string;
  name: string;
  description: string;
  requirements: string[];
  evaluationPolicy: Record<string, unknown>;
};

type Submission = {
  projectName: string;
  teamName: string;
  description: string;
  githubUrl: string;
  demoUrl: string;
  deployedContracts: unknown[];
};

export type ScoreOutcome<T> = { result: T; model: string | null };

/** Models occasionally wrap JSON in prose or a fence. Recover rather than discard. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

async function runStructured(
  env: Env,
  params: { system: string; user: string; schema: Record<string, unknown> },
): Promise<{ output: unknown; model: string } | null> {
  const model = env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  try {
    const response = (await env.AI.run(model as never, {
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      response_format: { type: "json_schema", json_schema: params.schema },
      max_tokens: 900,
    } as never)) as { response?: unknown };

    const raw = response?.response;
    if (raw == null) return null;
    const output = typeof raw === "string" ? extractJson(raw) : raw;
    if (output == null || typeof output !== "object") return null;
    return { output, model };
  } catch {
    return null;
  }
}

function clampScore(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function stringArray(value: unknown, limit = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, limit);
}

// ── TrackFit ────────────────────────────────────────────────────────────────

export async function runTrackFit(env: Env, track: Track, submission: Submission): Promise<ScoreOutcome<TrackFitResult>> {
  const attempt = await runStructured(env, {
    system:
      "You score a hackathon submission against a sponsor track. Judge only against the stated requirements. " +
      "Prefer a conservative rating when evidence is thin. Respond with strict JSON only.",
    user: JSON.stringify({
      track: { name: track.name, description: track.description, requirements: track.requirements },
      submission: {
        projectName: submission.projectName,
        description: submission.description,
        githubUrl: submission.githubUrl,
        demoUrl: submission.demoUrl,
        deployedContracts: submission.deployedContracts,
      },
    }),
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fit: { type: "string", enum: ["high", "medium", "low"] },
        flags: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" },
      },
      required: ["fit", "flags", "reasoning"],
    },
  });

  const raw = attempt?.output as Partial<TrackFitResult> | undefined;
  const fit = raw?.fit;
  if (attempt && (fit === "high" || fit === "medium" || fit === "low") && typeof raw?.reasoning === "string") {
    return {
      result: { fit, flags: stringArray(raw.flags), reasoning: raw.reasoning },
      model: attempt.model,
    };
  }
  return { result: heuristicTrackFit(track, submission), model: null };
}

// ── Quality ─────────────────────────────────────────────────────────────────

export async function runQuality(
  env: Env,
  track: Track,
  submission: Submission,
  eligibility: EligibilityResult,
  repo: RepoEvidence,
): Promise<ScoreOutcome<QualityResult>> {
  const weights = (track.evaluationPolicy?.weights as Record<string, number> | undefined) ?? null;

  const attempt = await runStructured(env, {
    system:
      "You review hackathon projects for execution quality. Score 0-100 using only the supplied evidence. " +
      (weights
        ? `Weight the criteria as configured by the organizer: ${JSON.stringify(weights)}. `
        : "Reward deployability, tests, architectural coherence and completeness. ") +
      "Do not reward marketing language. Respond with strict JSON only.",
    user: JSON.stringify({
      track: { name: track.name, description: track.description, requirements: track.requirements },
      submission: {
        projectName: submission.projectName,
        teamName: submission.teamName,
        description: submission.description,
        githubUrl: submission.githubUrl,
        demoUrl: submission.demoUrl,
        deployedContracts: submission.deployedContracts,
      },
      repositoryEvidence: repo,
      eligibility,
    }),
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        score: { type: "integer", minimum: 0, maximum: 100 },
        reasoning: { type: "string" },
        highlights: { type: "array", items: { type: "string" } },
        concerns: { type: "array", items: { type: "string" } },
      },
      required: ["score", "reasoning", "highlights", "concerns"],
    },
  });

  const raw = attempt?.output as Partial<QualityResult> | undefined;
  const score = clampScore(raw?.score);
  if (attempt && score !== null && typeof raw?.reasoning === "string" && raw.reasoning.trim().length > 0) {
    return {
      result: {
        score,
        reasoning: raw.reasoning,
        highlights: stringArray(raw.highlights),
        concerns: stringArray(raw.concerns),
      },
      model: attempt.model,
    };
  }
  return {
    result: heuristicQuality(track.evaluationPolicy as never, submission, eligibility),
    model: null,
  };
}

// ── Converge ────────────────────────────────────────────────────────────────

export type ClusterResult = { theme: string; rationale: string; members: string[] };

/**
 * Groups submissions into themes. Returns null when the model is unavailable — the caller must
 * then present an honest ungrouped view rather than inventing a grouping and attributing it to
 * an agent that never ran.
 */
export async function runConverge(
  env: Env,
  submissions: Array<{ id: string; projectName: string; description: string }>,
): Promise<ScoreOutcome<ClusterResult[]> | null> {
  if (submissions.length < 2) return null;

  const attempt = await runStructured(env, {
    system:
      "You group hackathon submissions into thematic clusters so judges can compare similar projects " +
      "side by side. Every submission id must appear in exactly one cluster. Give each cluster a short " +
      "theme name and one sentence explaining what its members share. Respond with strict JSON only.",
    user: JSON.stringify({
      submissions: submissions.map((entry) => ({
        id: entry.id,
        projectName: entry.projectName,
        description: entry.description.slice(0, 400),
      })),
    }),
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        clusters: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              theme: { type: "string" },
              rationale: { type: "string" },
              members: { type: "array", items: { type: "string" } },
            },
            required: ["theme", "rationale", "members"],
          },
        },
      },
      required: ["clusters"],
    },
  });

  const clusters = (attempt?.output as { clusters?: unknown } | undefined)?.clusters;
  if (!attempt || !Array.isArray(clusters)) return null;

  const known = new Set(submissions.map((entry) => entry.id));
  const seen = new Set<string>();
  const cleaned: ClusterResult[] = [];

  for (const cluster of clusters) {
    if (!cluster || typeof cluster !== "object") continue;
    const record = cluster as Record<string, unknown>;
    if (typeof record.theme !== "string" || typeof record.rationale !== "string") continue;
    // Drop hallucinated ids and never let a submission land in two clusters.
    const members = stringArray(record.members, 50).filter((id) => known.has(id) && !seen.has(id));
    if (!members.length) continue;
    members.forEach((id) => seen.add(id));
    cleaned.push({ theme: record.theme, rationale: record.rationale, members });
  }

  if (!cleaned.length) return null;

  const unassigned = submissions.filter((entry) => !seen.has(entry.id)).map((entry) => entry.id);
  if (unassigned.length) {
    cleaned.push({
      theme: "Ungrouped",
      rationale: "The similarity agent did not place these submissions in a theme.",
      members: unassigned,
    });
  }

  return { result: cleaned, model: attempt.model };
}
