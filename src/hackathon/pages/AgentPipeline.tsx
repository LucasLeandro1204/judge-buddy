import { useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FileSignature, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { approveAward, fetchEvents, fetchHackathon, fetchHackathons, fetchJobs, redeemClaim } from "@/hackathon/api";
import { signAwardApproval } from "@/hackathon/evm";
import { formatDateTime, formatTokenAmount, relativeTime, shorten } from "@/hackathon/format";
import { EmptyState, QueryErrorState } from "@/hackathon/QueryStates";
import { useAuth } from "@/auth/useAuth";
import { Button } from "@/components/ui/button";
import { hashscanEvmTxUrl, hashscanTransactionMessageUrl } from "@/contracts/config";

type ManifestField = {
  label: string;
  value: string;
  format?: string;
};

function readManifestString(manifest: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = manifest?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Read the `fields[]` the clear-signing manifest already carries. Never fabricates entries. */
function readManifestFields(manifest: Record<string, unknown> | null | undefined): ManifestField[] {
  const fields = manifest?.fields;
  if (!Array.isArray(fields)) return [];

  return fields
    .filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === "object")
    .map((field) => ({
      label: typeof field.label === "string" ? field.label : "",
      value: field.value === null || field.value === undefined ? "" : String(field.value),
      format: typeof field.format === "string" ? field.format : undefined,
    }))
    .filter((field) => field.label !== "" && field.value !== "");
}

function renderManifestValue(field: ManifestField): string {
  if (field.format === "amount") return formatTokenAmount(field.value);
  if (field.format === "timestamp") return formatDateTime(field.value);
  return field.value;
}

/**
 * The hardware-wallet story: render exactly what the signer will be asked to confirm,
 * as a labelled field list rather than a JSON blob.
 */
function ClearSigningManifest({ manifest }: { manifest: Record<string, unknown> | null | undefined }) {
  const fields = readManifestFields(manifest);
  const summary = readManifestString(manifest, "summary");
  const contractName = readManifestString(manifest, "contractName");
  const contractAddress = readManifestString(manifest, "contractAddress");
  const digest = readManifestString(manifest, "digest");
  const chainId = typeof manifest?.chainId === "number" ? manifest.chainId : null;

  return (
    <div className="mt-4 rounded-md border border-border bg-background/60 p-4">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground">
        <FileSignature className="h-3.5 w-3.5" />
        Clear-signing manifest
      </div>

      {summary ? <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{summary}</p> : null}

      {fields.length ? (
        <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {fields.map((field) => (
            <div key={field.label} className="min-w-0">
              <dt className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{field.label}</dt>
              <dd className="mt-1 break-all font-mono text-sm text-foreground">{renderManifestValue(field)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            This approval has no structured manifest fields. Show the raw payload.
          </summary>
          <pre className="mt-2 overflow-auto rounded-md bg-card p-3 text-[11px] text-muted-foreground">
            {JSON.stringify(manifest ?? {}, null, 2)}
          </pre>
        </details>
      )}

      {contractAddress || digest || chainId !== null ? (
        <div className="mt-4 grid gap-x-6 gap-y-3 border-t border-border pt-3 sm:grid-cols-2">
          {contractAddress ? (
            <div className="min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Contract{contractName ? ` (${contractName})` : ""}
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-foreground">{contractAddress}</div>
            </div>
          ) : null}
          {chainId !== null ? (
            <div className="min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Chain ID</div>
              <div className="mt-1 font-mono text-[11px] text-foreground">{chainId}</div>
            </div>
          ) : null}
          {digest ? (
            <div className="min-w-0 sm:col-span-2">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">EIP-712 digest</div>
              <div className="mt-1 break-all font-mono text-[11px] text-foreground">{digest}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AgentPipeline() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { authenticated, openAuthDialog, user } = useAuth();

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

  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: fetchJobs,
    refetchInterval: 5000,
  });

  const events = useQuery({
    queryKey: ["events", selectedHackathonId],
    queryFn: () => fetchEvents({ hackathonId: selectedHackathonId }),
    enabled: Boolean(selectedHackathonId),
    refetchInterval: 5000,
  });

  const awardsById = useMemo(() => {
    const entries = detail.data?.submissions
      .map((submission) => submission.awardProposal)
      .filter(Boolean)
      .map((award) => [award!.id, award!] as const);
    return new Map(entries ?? []);
  }, [detail.data?.submissions]);

  const submissionIds = useMemo(
    () => new Set((detail.data?.submissions ?? []).map((submission) => submission.id)),
    [detail.data?.submissions],
  );

  /** `GET /jobs` is global, so scope it to the selected hackathon before rendering. */
  const scopedJobs = useMemo(() => {
    if (!selectedHackathonId) return [];
    return (jobs.data ?? [])
      .filter((job) => {
        const jobHackathonId = typeof job.payload.hackathonId === "string" ? job.payload.hackathonId : null;
        if (jobHackathonId) return jobHackathonId === selectedHackathonId;

        const jobSubmissionId = typeof job.payload.submissionId === "string" ? job.payload.submissionId : null;
        if (jobSubmissionId) return submissionIds.has(jobSubmissionId);

        return false;
      })
      .slice(0, 12);
  }, [jobs.data, selectedHackathonId, submissionIds]);

  const scopedEvents = useMemo(() => (events.data ?? []).slice(0, 16), [events.data]);

  const approveMutation = useMutation({
    mutationFn: async (awardId: string) => {
      if (!detail.data) throw new Error("Hackathon not loaded");
      const approvalRequest = detail.data.approvals.find((entry) => entry.awardId === awardId);
      const award = awardsById.get(awardId);
      if (!approvalRequest || !award) throw new Error("Approval request or award missing");
      const payload = await signAwardApproval(detail.data, award, approvalRequest);
      return approveAward(awardId, payload);
    },
    onSuccess: async () => {
      toast.success("Award approved and relayed.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["hackathon", selectedHackathonId] }),
        queryClient.invalidateQueries({ queryKey: ["events", selectedHackathonId] }),
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Approval failed");
    },
  });

  const redeemMutation = useMutation({
    mutationFn: async (claimId: string) => redeemClaim(claimId),
    onSuccess: async () => {
      toast.success("Claim redeemed.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["hackathon", selectedHackathonId] }),
        queryClient.invalidateQueries({ queryKey: ["events", selectedHackathonId] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Claim redemption failed");
    },
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
        </Link>

        <select
          aria-label="Hackathon"
          value={selectedHackathonId}
          onChange={(event) => setParams({ h: event.target.value })}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto sm:max-w-xs"
        >
          {(hackathons.data ?? []).map((hackathon) => (
            <option key={hackathon.id} value={hackathon.id}>
              {hackathon.name}
            </option>
          ))}
        </select>
      </div>

      {hackathons.isError ? (
        <QueryErrorState
          title="Could not load hackathons"
          description="The event selector is empty because the API is unreachable, not because no hackathons exist."
          error={hackathons.error}
          onRetry={() => void hackathons.refetch()}
          isRetrying={hackathons.isFetching}
        />
      ) : null}

      {!authenticated ? (
        <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
          Sign in with the organizer or judge wallet to run live approval and redemption actions.
          <div className="mt-3">
            <Button onClick={openAuthDialog}>Sign in</Button>
          </div>
        </div>
      ) : null}

      {detail.isLoading ? (
        <div className="flex items-center gap-2 border border-border bg-card p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading operations
        </div>
      ) : detail.data ? (
        <>
          <section className="border border-border bg-card p-6">
            <div className="flex items-center gap-2 text-accent">
              <ShieldCheck className="h-4 w-4" />
              <span className="text-[10px] font-mono uppercase tracking-[0.3em]">Operations</span>
            </div>
            <h1 className="mt-3 text-2xl font-black tracking-tight text-foreground sm:text-3xl">{detail.data.name}</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Approvals are real EIP-712 signatures. If the connected MetaMask account is Ledger-backed, this same flow becomes the Ledger trust layer required by the track.
            </p>
          </section>

          <section className="grid gap-6 lg:grid-cols-[1.05fr,0.95fr]">
            <div className="space-y-6">
              <div className="border border-border bg-card p-6">
                <h2 className="text-lg font-black text-foreground">Approval queue</h2>
                <div className="mt-4 space-y-4">
                  {detail.data.approvals.map((approval) => {
                    const award = awardsById.get(approval.awardId);
                    const isDesignatedSigner = Boolean(
                      user &&
                        user.accountId === approval.signerAccountId &&
                        user.evmAddress === approval.signerEvmAddress,
                    );
                    const canApprove = authenticated && isDesignatedSigner && approval.status === "pending";
                    const blockedReason = !authenticated
                      ? `Sign in with ${approval.signerAccountId} to sign this approval.`
                      : !isDesignatedSigner
                        ? `Only ${approval.signerAccountId} (${shorten(approval.signerEvmAddress, 10, 8)}) can sign this approval. Switch to that account in MetaMask.`
                        : approval.status !== "pending"
                          ? `This approval is ${approval.status}, so it can no longer be signed.`
                          : null;

                    return (
                      <div key={approval.id} className="border border-border bg-background/40 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="font-mono text-sm text-foreground">{approval.actionType}</div>
                            <div className="mt-1 break-words text-[11px] text-muted-foreground">
                              signer {approval.signerAccountId} · expires {formatDateTime(approval.expiresAt)}
                            </div>
                          </div>
                          <div className="font-mono text-sm text-foreground">{approval.status}</div>
                        </div>

                        {award ? (
                          <div className="mt-4 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
                            <div className="min-w-0">
                              Award
                              <div className="break-all font-mono text-foreground">{award.id}</div>
                            </div>
                            <div className="min-w-0">
                              Amount
                              <div className="font-mono text-foreground">{formatTokenAmount(award.amount)}</div>
                            </div>
                            <div className="min-w-0">
                              Recipient
                              <div className="font-mono text-foreground">{shorten(award.winnerEvmAddress, 10, 8)}</div>
                            </div>
                            <div className="min-w-0">
                              Settlement
                              <div className="font-mono text-foreground">{award.settlementMode}</div>
                            </div>
                          </div>
                        ) : null}

                        <ClearSigningManifest manifest={approval.clearSigningManifest} />

                        {/* Once the signature is in and the contract has run, there is nothing left
                            to sign — offering the button again invites a call that can only revert. */}
                        {approval.status === "pending" ? (
                          <div className="mt-4 space-y-2">
                            <Button
                              onClick={() => approveMutation.mutate(approval.awardId)}
                              disabled={!canApprove || approveMutation.isPending}
                              title={blockedReason ?? undefined}
                            >
                              {approveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                              Sign and approve
                            </Button>
                            {blockedReason ? <p className="text-[11px] leading-5 text-muted-foreground">{blockedReason}</p> : null}
                          </div>
                        ) : (
                          <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
                            Signed and executed on-chain. Nothing further is required.
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {!detail.data.approvals.length ? (
                    <p className="text-sm text-muted-foreground">No approval requests are pending for this hackathon.</p>
                  ) : null}
                </div>
              </div>

              <div className="border border-border bg-card p-6">
                <h2 className="text-lg font-black text-foreground">Claims</h2>
                <div className="mt-4 space-y-4">
                  {detail.data.claims.map((claim) => {
                    const isClaimant = Boolean(
                      user && user.accountId === claim.claimantAccountId && user.evmAddress === claim.claimantEvmAddress,
                    );
                    const canRedeem = authenticated && isClaimant && claim.status === "minted";
                    const blockedReason = !authenticated
                      ? `Sign in with ${claim.claimantAccountId} to redeem this claim.`
                      : !isClaimant
                        ? `Only ${claim.claimantAccountId} (${shorten(claim.claimantEvmAddress, 10, 8)}) can redeem this claim. Switch to that account in MetaMask.`
                        : claim.status !== "minted"
                          ? `This claim is ${claim.status}, so there is nothing to redeem.`
                          : null;

                    return (
                      <div key={claim.id} className="border border-border bg-background/40 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="break-all font-mono text-sm text-foreground">{claim.id}</div>
                            <div className="mt-1 break-words text-[11px] text-muted-foreground">
                              claimant {claim.claimantAccountId} · serial {claim.serialNumber ?? "—"}
                            </div>
                          </div>
                          <div className="font-mono text-sm text-foreground">{claim.status}</div>
                        </div>
                        <div className="mt-4 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
                          <div className="min-w-0">
                            Token
                            <div className="font-mono text-foreground">{shorten(claim.tokenAddress, 10, 8)}</div>
                          </div>
                          <div className="min-w-0">
                            Metadata
                            <div className="break-all font-mono text-foreground">{claim.metadataURI ?? "—"}</div>
                          </div>
                        </div>
                        {/* A redeemed claim's NFT has been burned; there is nothing left to redeem. */}
                        {claim.status === "redeemed" ? (
                          <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
                            Redeemed. The claim NFT was burned and the payout released to the winner.
                          </p>
                        ) : (
                          <div className="mt-4 space-y-2">
                            <Button
                              variant="outline"
                              onClick={() => redeemMutation.mutate(claim.id)}
                              disabled={!canRedeem || redeemMutation.isPending}
                              title={blockedReason ?? undefined}
                            >
                              {redeemMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                              Redeem claim
                            </Button>
                            {blockedReason ? <p className="text-[11px] leading-5 text-muted-foreground">{blockedReason}</p> : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!detail.data.claims.length ? (
                    <p className="text-sm text-muted-foreground">No claim tokens minted yet.</p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="border border-border bg-card p-6">
                <h2 className="text-lg font-black text-foreground">Jobs</h2>
                <p className="mt-1 text-[11px] text-muted-foreground">Worker jobs scoped to this hackathon.</p>
                <div className="mt-4 space-y-3">
                  {jobs.isError ? (
                    <QueryErrorState
                      title="Could not load jobs"
                      description="The worker queue could not be read, so this list is unknown rather than idle."
                      error={jobs.error}
                      onRetry={() => void jobs.refetch()}
                      isRetrying={jobs.isFetching}
                    />
                  ) : jobs.isLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading jobs
                    </div>
                  ) : scopedJobs.length ? (
                    scopedJobs.map((job) => (
                      <div key={job.id} className="border border-border bg-background/40 p-3 text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="break-words font-mono text-foreground">{job.type}</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">{relativeTime(job.createdAt)}</div>
                          </div>
                          <div className="font-mono text-foreground">{job.status}</div>
                        </div>
                        {job.lastError ? <p className="mt-2 break-words text-[11px] text-destructive">{job.lastError}</p> : null}
                      </div>
                    ))
                  ) : (
                    <EmptyState
                      className="bg-background/40"
                      title="No jobs for this hackathon"
                      description="Queue an evaluation from the submissions page and the worker jobs will appear here."
                    />
                  )}
                </div>
              </div>

              <div className="border border-border bg-card p-6">
                <h2 className="text-lg font-black text-foreground">Event stream</h2>
                <div className="mt-4 space-y-3">
                  {events.isError ? (
                    <QueryErrorState
                      title="Could not load events"
                      description="The audit stream could not be read, so no conclusion can be drawn about what has happened on-chain."
                      error={events.error}
                      onRetry={() => void events.refetch()}
                      isRetrying={events.isFetching}
                    />
                  ) : events.isLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading events
                    </div>
                  ) : scopedEvents.length ? (
                    scopedEvents.map((event) => {
                      const txHref = event.txHash ? hashscanEvmTxUrl(event.txHash) : null;
                      const hcsHref = event.hcsTxId ? hashscanTransactionMessageUrl(event.hcsTxId) : null;
                      const primaryHref = hcsHref ?? txHref;

                      const content = (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="break-words font-mono text-foreground">{event.type}</div>
                              <div className="mt-1 text-[11px] text-muted-foreground">
                                {event.source} · {relativeTime(event.createdAt)}
                              </div>
                            </div>
                            {primaryHref ? (
                              <div className="flex shrink-0 flex-col items-end gap-1 text-[11px] text-accent">
                                <span className="inline-flex items-center gap-1">
                                  {hcsHref ? "HCS message" : "Tx"}
                                  <ExternalLink className="h-3 w-3" />
                                </span>
                              </div>
                            ) : null}
                          </div>
                          <div className="mt-2 text-[11px] text-muted-foreground">{formatDateTime(event.createdAt)}</div>
                          {event.hcsTopicId && event.hcsSequenceNumber ? (
                            <div className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                              topic {event.hcsTopicId} · seq {event.hcsSequenceNumber}
                            </div>
                          ) : null}
                        </>
                      );

                      return primaryHref ? (
                        <a
                          key={event.id}
                          href={primaryHref}
                          target="_blank"
                          rel="noreferrer"
                          className="block border border-border bg-background/40 p-3 text-sm transition-colors hover:border-accent/60 hover:bg-background/70"
                        >
                          {content}
                        </a>
                      ) : (
                        <div key={event.id} className="border border-border bg-background/40 p-3 text-sm">
                          {content}
                        </div>
                      );
                    })
                  ) : (
                    <EmptyState
                      className="bg-background/40"
                      title="No events recorded yet"
                      description="Funding, evaluation, approval, and payout activity is appended here with HashScan links as it happens."
                    />
                  )}
                </div>
              </div>
            </div>
          </section>
        </>
      ) : detail.isError ? (
        <QueryErrorState
          title="Could not load operations"
          description="JudgeBuddy could not reach its API to load this hackathon's approval and claim state."
          error={detail.error}
          onRetry={() => void detail.refetch()}
          isRetrying={detail.isFetching}
        />
      ) : (
        <EmptyState title="No hackathon selected" description="Pick an event above to review its operations." />
      )}
    </div>
  );
}
