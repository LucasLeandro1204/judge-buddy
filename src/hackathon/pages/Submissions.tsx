import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EvaluationRun, SimilarityCluster, SubmissionRecord } from "@shared/treasury";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Layers3,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchHackathon, fetchHackathons, queueEvaluation } from "@/hackathon/api";
import { formatDateTime, formatTokenAmount, relativeTime, shorten } from "@/hackathon/format";
import { EmptyState, QueryErrorState } from "@/hackathon/QueryStates";
import { cn } from "@/lib/utils";

type ViewMode = "themes" | "all";

/**
 * A displayed group of submissions.
 *
 * `provenance` is non-null **only** when the grouping was produced by the server's
 * similarity agent. When it is null the grouping is a local fallback (by track, or
 * "not yet clustered") and the UI must not render agent/model/method badges for it —
 * inventing those would fake the audit trail.
 */
type SubmissionGroup = {
  id: string;
  label: string;
  description: string;
  provenance: SimilarityCluster | null;
  submissions: SubmissionRecord[];
};

const STATUS_LABELS: Record<SubmissionRecord["status"], string> = {
  pending: "Pending review",
  eligible: "Eligible",
  ineligible: "Ineligible",
  evaluated: "Scored",
  awarded: "Award ready",
  paid: "Paid",
};

const STATUS_STYLES: Record<SubmissionRecord["status"], string> = {
  pending: "border-white/10 bg-white/5 text-muted-foreground",
  eligible: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  ineligible: "border-rose-500/20 bg-rose-500/10 text-rose-300",
  evaluated: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  awarded: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  paid: "border-primary/20 bg-primary/10 text-primary",
};

const FIT_STYLES: Record<"high" | "medium" | "low", string> = {
  high: "border-primary/20 bg-primary/10 text-primary",
  medium: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  low: "border-rose-500/20 bg-rose-500/10 text-rose-300",
};

function readScore(result: Record<string, unknown> | null | undefined): number | null {
  if (!result || typeof result.score !== "number") return null;
  return result.score;
}

function readFit(result: Record<string, unknown> | null | undefined): "high" | "medium" | "low" | null {
  if (!result || typeof result.fit !== "string") return null;
  if (result.fit === "high" || result.fit === "medium" || result.fit === "low") return result.fit;
  return null;
}

function readPassed(result: Record<string, unknown> | null | undefined): boolean | null {
  if (!result || typeof result.passed !== "boolean") return null;
  return result.passed;
}

function getRun(submission: SubmissionRecord, role: EvaluationRun["agentRole"]) {
  return submission.evaluationRuns.find((run) => run.agentRole === role) ?? null;
}

function averageScore(submissions: SubmissionRecord[]): number | null {
  const scores = submissions.map((submission) => readScore(getRun(submission, "quality")?.result)).filter((score): score is number => score !== null);
  if (!scores.length) return null;
  return Math.round(scores.reduce((total, score) => total + score, 0) / scores.length);
}

function countEligible(submissions: SubmissionRecord[]): number {
  return submissions.filter((submission) => {
    const passed = readPassed(getRun(submission, "eligibility")?.result);
    return passed === true || submission.status === "eligible" || submission.status === "evaluated" || submission.status === "awarded" || submission.status === "paid";
  }).length;
}

function describeMethod(cluster: SimilarityCluster): string {
  // Must name the method that actually ran. A binary embeddings/lexical split labelled every
  // LLM-produced grouping "Lexical fallback", which understates and misreports the provenance.
  switch (cluster.method) {
    case "embeddings":
      return "AI embeddings";
    case "llm":
      return "LLM grouping";
    case "lexical":
      return "Lexical fallback";
    default:
      return cluster.method;
  }
}

function formatFitLabel(fit: "high" | "medium" | "low"): string {
  return `${fit.toUpperCase()} FIT`;
}

function describeRun(run: EvaluationRun): string {
  const result = run.result ?? {};

  if (run.agentRole === "eligibility") {
    return typeof result.notes === "string" && result.notes ? result.notes : "Eligibility checks completed.";
  }
  if (run.agentRole === "track-fit") {
    return typeof result.reasoning === "string" && result.reasoning ? result.reasoning : "Track fit analysis stored.";
  }
  if (run.agentRole === "quality") {
    return typeof result.reasoning === "string" && result.reasoning ? result.reasoning : "Quality analysis stored.";
  }
  return "Agent output stored for manual review.";
}

export default function Submissions() {
  const [params, setParams] = useSearchParams();
  const [viewMode, setViewMode] = useState<ViewMode>("themes");
  const queryClient = useQueryClient();

  const hackathons = useQuery({
    queryKey: ["hackathons"],
    queryFn: fetchHackathons,
  });

  const selectedHackathonId = useMemo(() => {
    const fromQuery = params.get("h");
    if (fromQuery) return fromQuery;
    return hackathons.data?.[0]?.id ?? "";
  }, [hackathons.data, params]);

  useEffect(() => {
    if (!params.get("h") && hackathons.data?.[0]?.id) {
      setParams({ h: hackathons.data[0].id });
    }
  }, [hackathons.data, params, setParams]);

  const detail = useQuery({
    queryKey: ["hackathon", selectedHackathonId],
    queryFn: () => fetchHackathon(selectedHackathonId),
    enabled: Boolean(selectedHackathonId),
    refetchInterval: 8000,
  });

  useEffect(() => {
    if (!detail.data?.submissions.length) return;
    const selectedSubmissionId = params.get("id");
    if (selectedSubmissionId && detail.data.submissions.some((submission) => submission.id === selectedSubmissionId)) return;
    setParams({ h: selectedHackathonId, id: detail.data.submissions[0].id });
  }, [detail.data?.submissions, params, selectedHackathonId, setParams]);

  const selectedSubmissionId = params.get("id");
  const selectedSubmission = useMemo(
    () => detail.data?.submissions.find((submission) => submission.id === selectedSubmissionId) ?? detail.data?.submissions[0] ?? null,
    [detail.data?.submissions, selectedSubmissionId],
  );

  const trackLookup = useMemo(
    () => new Map((detail.data?.tracks ?? []).map((track) => [track.id, track])),
    [detail.data?.tracks],
  );

  const submissionGroups = useMemo<SubmissionGroup[]>(() => {
    if (!detail.data?.submissions.length) return [];

    const allSubmissions = detail.data.submissions;
    const submissionById = new Map(allSubmissions.map((submission) => [submission.id, submission]));

    const agentClusters = (detail.data.similarityClusters ?? [])
      .map((cluster) => ({
        cluster,
        submissions: cluster.submissionIds
          .map((submissionId) => submissionById.get(submissionId))
          .filter((submission): submission is SubmissionRecord => Boolean(submission)),
      }))
      .filter((entry) => entry.submissions.length > 0);

    // No server clusters: fall back to grouping by sponsor track. No agent, model, or
    // method is attached, because the similarity agent has produced nothing to attribute.
    if (!agentClusters.length) {
      const byTrack = new Map<string, SubmissionRecord[]>();
      for (const submission of allSubmissions) {
        const existing = byTrack.get(submission.trackId);
        if (existing) existing.push(submission);
        else byTrack.set(submission.trackId, [submission]);
      }

      return [...byTrack.entries()].map(([trackId, submissions]) => ({
        id: `track-${trackId}`,
        label: trackLookup.get(trackId)?.name ?? trackId,
        description: "Grouped by track — the similarity agent has not run for this hackathon yet.",
        provenance: null,
        submissions,
      }));
    }

    const groups: SubmissionGroup[] = agentClusters.map(({ cluster, submissions }) => ({
      id: cluster.id,
      label: cluster.label,
      description: cluster.theme,
      provenance: cluster,
      submissions,
    }));

    const coveredIds = new Set(groups.flatMap((group) => group.submissions.map((submission) => submission.id)));
    const remainder = allSubmissions.filter((submission) => !coveredIds.has(submission.id));

    if (remainder.length) {
      groups.push({
        id: "ungrouped-submissions",
        label: "Not yet clustered",
        description: "The similarity agent has not assigned these submissions to a theme.",
        provenance: null,
        submissions: remainder,
      });
    }

    return groups;
  }, [detail.data, trackLookup]);

  const hasAgentClusters = submissionGroups.some((group) => group.provenance !== null);
  const groupingLabel = hasAgentClusters ? "By theme" : "By track";
  const groupCountLabel = hasAgentClusters ? "themes" : "track groups";
  const effectiveViewMode = viewMode === "themes" && submissionGroups.length > 0 ? "themes" : "all";

  const queueMutation = useMutation({
    mutationFn: async (submissionId: string) => queueEvaluation(submissionId, true),
    onSuccess: async () => {
      toast.success("Evaluation queued.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["hackathon", selectedHackathonId] }),
        queryClient.invalidateQueries({ queryKey: ["events", selectedHackathonId] }),
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not queue evaluation");
    },
  });

  const renderSubmissionCard = (submission: SubmissionRecord) => {
    const qualityRun = getRun(submission, "quality");
    const trackFitRun = getRun(submission, "track-fit");
    const eligibilityRun = getRun(submission, "eligibility");
    const score = readScore(qualityRun?.result);
    const fit = readFit(trackFitRun?.result);
    const passed = readPassed(eligibilityRun?.result);
    const trackName = trackLookup.get(submission.trackId)?.name ?? submission.trackId;

    return (
      <button
        key={submission.id}
        type="button"
        onClick={() => setParams({ h: selectedHackathonId, id: submission.id })}
        className={cn(
          "group w-full overflow-hidden rounded-[22px] border p-4 text-left transition-all duration-200",
          "bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] hover:border-accent/50 hover:bg-white/[0.045]",
          selectedSubmission?.id === submission.id
            ? "border-accent/80 shadow-[0_0_0_1px_rgba(251,191,36,0.18),0_18px_40px_rgba(0,0,0,0.35)]"
            : "border-white/10",
        )}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex shrink-0 items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-background/80 font-mono text-2xl font-semibold text-foreground">
              {score ?? "—"}
            </div>
            <div className="flex flex-col gap-2">
              <Badge className={cn("w-fit border", STATUS_STYLES[submission.status])}>{STATUS_LABELS[submission.status]}</Badge>
              {fit ? <Badge className={cn("w-fit border", FIT_STYLES[fit])}>{formatFitLabel(fit)}</Badge> : null}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="min-w-0 break-words text-lg font-bold tracking-tight text-foreground">{submission.projectName}</h2>
              <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{submission.teamName}</span>
            </div>

            <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{submission.description}</p>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
              <span>{trackName}</span>
              <span className="text-white/20">•</span>
              <span>{relativeTime(submission.createdAt)}</span>
              {passed !== null ? (
                <>
                  <span className="text-white/20">•</span>
                  <span className={passed ? "text-primary" : "text-rose-300"}>{passed ? "Eligible" : "Needs fixes"}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
            {submission.status === "ineligible" ? (
              <XCircle className="h-5 w-5 text-rose-300" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-primary" />
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="mx-auto max-w-[92rem] space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.24em] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
        </Link>

        <div className="w-full max-w-md">
          <p className="mb-2 text-[11px] font-mono uppercase tracking-[0.24em] text-muted-foreground">Event</p>
          <select
            value={selectedHackathonId}
            onChange={(event) => setParams({ h: event.target.value })}
            className="h-12 w-full rounded-2xl border border-white/10 bg-card/80 px-4 text-sm text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-colors focus:border-accent/70"
          >
            {(hackathons.data ?? []).map((hackathon) => (
              <option key={hackathon.id} value={hackathon.id}>
                {hackathon.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {hackathons.isError ? (
        <QueryErrorState
          className="rounded-[24px]"
          title="Could not load hackathons"
          description="The event list could not be fetched, so the selector above is empty because the API is unreachable — not because no hackathons exist."
          error={hackathons.error}
          onRetry={() => void hackathons.refetch()}
          isRetrying={hackathons.isFetching}
        />
      ) : null}

      {detail.isLoading ? (
        <div className="flex items-center gap-3 rounded-[24px] border border-white/10 bg-card/70 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading submissions
        </div>
      ) : detail.data ? (
        <>
          <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(250,204,21,0.14),transparent_36%),radial-gradient(circle_at_80%_0,rgba(34,197,94,0.12),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-8">
            <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-muted-foreground">Submission review</p>
                <h1 className="mt-4 max-w-4xl break-words text-3xl font-black tracking-tight text-foreground sm:text-4xl xl:text-5xl">
                  {detail.data.name} <span className="text-foreground/55">—</span> Submissions
                </h1>
                <p className="mt-4 max-w-3xl break-words text-sm leading-7 text-muted-foreground sm:text-base">
                  {detail.data.tagline}. Review similarity themes first, then inspect evaluation evidence, award readiness, and claim state per project.
                </p>
              </div>

              <div className="flex flex-col gap-4 xl:items-end">
                <div className="inline-flex items-center rounded-2xl border border-white/10 bg-black/30 p-1">
                  <button
                    type="button"
                    onClick={() => setViewMode("themes")}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-[14px] px-4 py-2 text-sm transition-colors",
                      effectiveViewMode === "themes" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <LayoutGrid className="h-4 w-4" />
                    {groupingLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("all")}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-[14px] px-4 py-2 text-sm transition-colors",
                      effectiveViewMode === "all" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <List className="h-4 w-4" />
                    All submissions
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono uppercase tracking-[0.24em] text-muted-foreground">
                  <span>{detail.data.submissions.length} submitted</span>
                  <span className="text-white/20">•</span>
                  <span>
                    {submissionGroups.length} {groupCountLabel}
                  </span>
                  <span className="text-white/20">•</span>
                  <span>{detail.data.tracks.length} sponsor tracks</span>
                </div>
              </div>
            </div>
          </section>

          {!detail.data.submissions.length ? (
            <div className="rounded-[24px] border border-white/10 bg-card/70 p-8 text-sm text-muted-foreground">
              No submissions yet. Share the submit flow with teams once the treasury is funded.
            </div>
          ) : (
            <div className="grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.95fr)]">
              <section className="min-w-0 space-y-5">
                {effectiveViewMode === "themes" ? (
                  submissionGroups.map((group) => {
                    const provenance = group.provenance;
                    const groupAverage = averageScore(group.submissions);
                    const eligibleCount = countEligible(group.submissions);
                    return (
                      <article
                        key={group.id}
                        className={cn(
                          "overflow-hidden rounded-[28px] border p-5 shadow-[0_18px_42px_rgba(0,0,0,0.28)] sm:p-6",
                          provenance
                            ? "border-violet-500/20 bg-[linear-gradient(180deg,rgba(96,47,149,0.1),rgba(255,255,255,0.02))]"
                            : "border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))]",
                        )}
                      >
                        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex items-start gap-4">
                              <div
                                className={cn(
                                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border",
                                  provenance
                                    ? "border-violet-400/20 bg-violet-500/10 text-violet-200"
                                    : "border-white/10 bg-white/5 text-muted-foreground",
                                )}
                              >
                                <Layers3 className="h-5 w-5" />
                              </div>
                              <div className="min-w-0">
                                <h2 className="break-words text-2xl font-black tracking-tight text-foreground">{group.label}</h2>
                                <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-muted-foreground">{group.description}</p>
                              </div>
                            </div>
                          </div>

                          {/* Provenance badges are rendered only for server-produced clusters. */}
                          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
                            {provenance ? (
                              <>
                                <Badge className="border border-white/10 bg-white/5 text-muted-foreground">{describeMethod(provenance)}</Badge>
                                <Badge className="border border-white/10 bg-white/5 text-muted-foreground">{provenance.model}</Badge>
                                <Badge className="border border-white/10 bg-white/5 text-muted-foreground">{provenance.agentId}</Badge>
                                <Badge className="border border-white/10 bg-white/5 text-muted-foreground">{relativeTime(provenance.clusteredAt)}</Badge>
                              </>
                            ) : (
                              <Badge className="border border-white/10 bg-white/5 text-muted-foreground">No agent run</Badge>
                            )}
                          </div>
                        </div>

                        <div className="mt-5 rounded-[20px] border border-white/10 bg-black/20 p-4">
                          {provenance ? (
                            <>
                              <div className="flex items-start gap-3">
                                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                                <p className="min-w-0 break-words text-sm leading-6 text-muted-foreground">{provenance.agentRationale}</p>
                              </div>

                              <div className="mt-4 flex flex-wrap gap-2">
                                {provenance.keywords.slice(0, 4).map((keyword) => (
                                  <Badge key={keyword} className="border border-white/10 bg-white/5 text-muted-foreground">
                                    {keyword}
                                  </Badge>
                                ))}
                              </div>
                            </>
                          ) : (
                            <p className="break-words text-sm leading-6 text-muted-foreground">
                              This grouping is derived locally from the sponsor track on each submission. No similarity agent has
                              produced a clustering for this hackathon, so there is no model, method, or agent run to attribute it to.
                            </p>
                          )}

                          <div className="mt-5 grid gap-3 sm:grid-cols-3">
                            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                              <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
                                {provenance ? "Theme size" : "Group size"}
                              </div>
                              <div className="mt-2 text-2xl font-black text-foreground">{group.submissions.length}</div>
                            </div>
                            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                              <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Avg quality</div>
                              <div className="mt-2 text-2xl font-black text-foreground">{groupAverage ?? "—"}</div>
                            </div>
                            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                              <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
                                {provenance && provenance.cohesion !== null ? "Similarity" : "Eligible"}
                              </div>
                              <div className="mt-2 text-2xl font-black text-foreground">
                                {provenance && provenance.cohesion !== null ? `${Math.round(provenance.cohesion * 100)}%` : eligibleCount}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="mt-5 space-y-3">{group.submissions.map((submission) => renderSubmissionCard(submission))}</div>
                      </article>
                    );
                  })
                ) : (
                  <article className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] p-5 shadow-[0_18px_42px_rgba(0,0,0,0.28)] sm:p-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div className="min-w-0">
                        <h2 className="break-words text-2xl font-black tracking-tight text-foreground">All submissions</h2>
                        <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
                          A flat queue for manual review when you want to inspect every project without theme grouping.
                        </p>
                      </div>
                      <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
                        {detail.data.submissions.length} total
                      </div>
                    </div>
                    <div className="mt-5 space-y-3">{detail.data.submissions.map((submission) => renderSubmissionCard(submission))}</div>
                  </article>
                )}
              </section>

              <aside className="min-w-0 space-y-4 xl:sticky xl:top-8 xl:self-start">
                {selectedSubmission ? (
                  <>
                    <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] p-6 shadow-[0_18px_42px_rgba(0,0,0,0.28)]">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-[11px] font-mono uppercase tracking-[0.24em] text-muted-foreground">Selected submission</p>
                          <h2 className="mt-3 break-words text-2xl font-black tracking-tight text-foreground">{selectedSubmission.projectName}</h2>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Badge className={cn("border", STATUS_STYLES[selectedSubmission.status])}>
                              {STATUS_LABELS[selectedSubmission.status]}
                            </Badge>
                            <Badge className="border border-white/10 bg-white/5 text-muted-foreground">
                              {trackLookup.get(selectedSubmission.trackId)?.name ?? selectedSubmission.trackId}
                            </Badge>
                            <Badge className="border border-white/10 bg-white/5 text-muted-foreground">{selectedSubmission.teamName}</Badge>
                          </div>
                        </div>

                        <div className="shrink-0 rounded-[22px] border border-white/10 bg-black/25 px-4 py-3 text-center">
                          <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Quality</div>
                          <div className="mt-2 font-mono text-3xl font-semibold text-foreground">
                            {readScore(getRun(selectedSubmission, "quality")?.result) ?? "—"}
                          </div>
                        </div>
                      </div>

                      <p className="mt-5 break-words text-sm leading-7 text-muted-foreground">{selectedSubmission.description}</p>

                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Payout account</div>
                          <div className="mt-2 break-all font-mono text-sm text-foreground">{selectedSubmission.payoutAccountId}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Payout EVM</div>
                          <div className="mt-2 break-all font-mono text-sm text-foreground">{selectedSubmission.payoutEvmAddress}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Submitted</div>
                          <div className="mt-2 break-words text-sm text-foreground">{formatDateTime(selectedSubmission.createdAt)}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Contracts</div>
                          <div className="mt-2 break-words text-sm text-foreground">{selectedSubmission.deployedContracts.length}</div>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap gap-2">
                        <Button variant="outline" asChild>
                          <a href={selectedSubmission.githubUrl} target="_blank" rel="noreferrer">
                            GitHub
                            <ExternalLink className="ml-2 h-3.5 w-3.5" />
                          </a>
                        </Button>
                        {selectedSubmission.demoUrl ? (
                          <Button variant="outline" asChild>
                            <a href={selectedSubmission.demoUrl} target="_blank" rel="noreferrer">
                              Demo
                              <ExternalLink className="ml-2 h-3.5 w-3.5" />
                            </a>
                          </Button>
                        ) : null}
                        <Button onClick={() => queueMutation.mutate(selectedSubmission.id)} disabled={queueMutation.isPending}>
                          {queueMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                          Re-run evaluation
                        </Button>
                      </div>
                    </section>

                    <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] p-6 shadow-[0_18px_42px_rgba(0,0,0,0.28)]">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-lg font-black text-foreground">Agent runs</h3>
                          <p className="mt-1 text-sm text-muted-foreground">Machine evidence and stored decision traces.</p>
                        </div>
                        <span className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
                          {selectedSubmission.evaluationRuns.length} runs
                        </span>
                      </div>

                      <div className="mt-4 space-y-3">
                        {selectedSubmission.evaluationRuns.length ? (
                          selectedSubmission.evaluationRuns.map((run) => (
                            <div key={run.id} className="rounded-[22px] border border-white/10 bg-black/20 p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="font-mono text-sm uppercase tracking-[0.22em] text-foreground">{run.agentRole}</div>
                                  <div className="mt-1 text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
                                    {run.status} • {run.completedAt ? relativeTime(run.completedAt) : "pending"}
                                  </div>
                                </div>
                                <div className="text-right text-[11px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
                                  {run.completedAt ? formatDateTime(run.completedAt) : "—"}
                                </div>
                              </div>

                              <p className="mt-3 break-words text-sm leading-6 text-muted-foreground">{describeRun(run)}</p>

                              {run.agentRole === "quality" && Array.isArray(run.result?.highlights) && run.result.highlights.length ? (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {run.result.highlights.slice(0, 3).map((highlight) => (
                                    <Badge key={String(highlight)} className="border border-primary/20 bg-primary/10 text-primary">
                                      {String(highlight)}
                                    </Badge>
                                  ))}
                                </div>
                              ) : null}

                              {run.agentRole === "quality" && Array.isArray(run.result?.concerns) && run.result.concerns.length ? (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {run.result.concerns.slice(0, 3).map((concern) => (
                                    <Badge key={String(concern)} className="border border-rose-500/20 bg-rose-500/10 text-rose-300">
                                      {String(concern)}
                                    </Badge>
                                  ))}
                                </div>
                              ) : null}

                              {run.result && run.agentRole !== "quality" ? (
                                <pre className="mt-3 overflow-x-auto rounded-2xl border border-white/10 bg-background/80 p-3 text-[11px] leading-6 text-muted-foreground whitespace-pre-wrap break-words">
                                  {JSON.stringify(run.result, null, 2)}
                                </pre>
                              ) : null}

                              {run.error ? <p className="mt-3 break-words text-[11px] text-destructive">{run.error}</p> : null}
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-muted-foreground">No evaluation runs stored yet.</p>
                        )}
                      </div>
                    </section>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                      <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] p-6 shadow-[0_18px_42px_rgba(0,0,0,0.28)]">
                        <h3 className="text-lg font-black text-foreground">Award proposal</h3>
                        {selectedSubmission.awardProposal ? (
                          <div className="mt-4 space-y-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Status</span>
                              <span className="break-words font-mono text-foreground">{selectedSubmission.awardProposal.status}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Settlement</span>
                              <span className="break-words font-mono text-foreground">{selectedSubmission.awardProposal.settlementMode}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Amount</span>
                              <span className="break-words font-mono text-foreground">
                                {formatTokenAmount(selectedSubmission.awardProposal.amount)}
                              </span>
                            </div>
                            <p className="pt-2 break-words text-[13px] leading-6 text-muted-foreground">
                              {selectedSubmission.awardProposal.reason}
                            </p>
                          </div>
                        ) : (
                          <p className="mt-4 text-sm leading-6 text-muted-foreground">No award has been proposed for this submission yet.</p>
                        )}
                      </section>

                      <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] p-6 shadow-[0_18px_42px_rgba(0,0,0,0.28)]">
                        <h3 className="text-lg font-black text-foreground">Claim</h3>
                        {selectedSubmission.claim ? (
                          <div className="mt-4 space-y-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Status</span>
                              <span className="break-words font-mono text-foreground">{selectedSubmission.claim.status}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Token</span>
                              <span className="break-words font-mono text-foreground">{shorten(selectedSubmission.claim.tokenAddress, 10, 8)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Serial</span>
                              <span className="break-words font-mono text-foreground">{selectedSubmission.claim.serialNumber ?? "—"}</span>
                            </div>
                            <div className="break-words text-[13px] leading-6 text-muted-foreground">
                              Redeemed tx: {shorten(selectedSubmission.claim.redeemedTxHash, 10, 8)}
                            </div>
                          </div>
                        ) : (
                          <p className="mt-4 text-sm leading-6 text-muted-foreground">No claim token exists for this submission.</p>
                        )}
                      </section>
                    </div>
                  </>
                ) : (
                  <div className="rounded-[24px] border border-white/10 bg-card/70 p-6 text-sm text-muted-foreground">
                    Select a submission to inspect its evaluation and award state.
                  </div>
                )}
              </aside>
            </div>
          )}
        </>
      ) : detail.isError ? (
        <QueryErrorState
          className="rounded-[24px]"
          title="Could not load submissions"
          description="JudgeBuddy could not reach its API to load this hackathon. Nothing below is missing data — the request itself failed."
          error={detail.error}
          onRetry={() => void detail.refetch()}
          isRetrying={detail.isFetching}
        />
      ) : (
        <EmptyState
          className="rounded-[24px] border-white/10 bg-card/70"
          title="No hackathon selected"
          description="Pick an event above to review its submissions."
        />
      )}
    </div>
  );
}
