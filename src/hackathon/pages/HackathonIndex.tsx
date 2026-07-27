import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, CircleDollarSign, ClipboardCheck, Loader2, ShieldCheck, Trophy } from "lucide-react";
import { fetchHackathons, fetchHealth } from "@/hackathon/api";
import { formatDateTime, formatTokenAmount, shorten } from "@/hackathon/format";
import { EmptyState, QueryErrorState } from "@/hackathon/QueryStates";
import { Button } from "@/components/ui/button";

const statusLabel: Record<string, string> = {
  draft: "Draft",
  funding: "Funding",
  live: "Live",
  judging: "Judging",
  completed: "Completed",
};

export default function HackathonIndex() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    retry: false,
  });
  const hackathons = useQuery({
    queryKey: ["hackathons"],
    queryFn: fetchHackathons,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section className="grid gap-4 lg:grid-cols-[1.4fr,0.8fr]">
        <div className="border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-accent">
            <ShieldCheck className="h-4 w-4" />
            <span className="text-[10px] font-mono uppercase tracking-[0.3em]">Real Treasury Ops</span>
          </div>
          <h1 className="mt-3 text-4xl font-black tracking-tight text-foreground">Hackathon prizes, approvals, and claims on Hedera.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            JudgeBuddy now runs as a live treasury workflow: organizers fund prize pools, agents evaluate submissions, judges approve high-risk awards with typed data, and winners redeem tokenized claims.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/hackathon/create">Create Hackathon</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/hackathon/submit">Submit Project</Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/hackathon/agents">Open Operations</Link>
            </Button>
          </div>
        </div>

        <div className="border border-border bg-card p-6">
          <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground">Runtime</p>
          {health.isLoading ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading API status
            </div>
          ) : health.data ? (
            <div className="mt-4 space-y-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">API health</span>
                <span className="font-mono text-primary">{health.data.ok ? "online" : "offline"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Treasury contract</span>
                <span className="font-mono text-foreground">{health.data.treasuryContractConfigured ? "configured" : "missing"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Claim token</span>
                <span className="font-mono text-foreground">{health.data.prizeClaimTokenConfigured ? "configured" : "missing"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Network</span>
                <span className="font-mono text-foreground">{health.data.network}</span>
              </div>
              <div className="rounded-md border border-border bg-background/50 p-3 text-[11px] text-muted-foreground">
                Mirror: <span className="font-mono text-foreground">{health.data.mirrorBase}</span>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-destructive">{health.error instanceof Error ? health.error.message : "API unavailable"}</p>
          )}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {[
          { icon: CircleDollarSign, label: "Treasury Funding", text: "Organizer approves ERC-20 spend, then bootstraps a per-track treasury on Hedera EVM." },
          { icon: Bot, label: "Agent Pipeline", text: "Eligibility, track-fit, quality, treasury, and policy explanation runs are persisted as jobs and events." },
          { icon: ClipboardCheck, label: "Ledger-Ready Approvals", text: "Judges sign the exact EIP-712 award payload. Ledger-backed MetaMask accounts work without separate mocks." },
        ].map((item) => (
          <div key={item.label} className="border border-border bg-card p-5">
            <item.icon className="h-4 w-4 text-accent" />
            <h2 className="mt-3 text-sm font-bold text-foreground">{item.label}</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.text}</p>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground">Hackathons</p>
            <h2 className="mt-1 text-xl font-black text-foreground">Live treasury programs</h2>
          </div>
          <Button variant="outline" asChild>
            <Link to="/hackathon/create">New Hackathon</Link>
          </Button>
        </div>

        {hackathons.isLoading ? (
          <div className="flex items-center gap-2 border border-border bg-card p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading hackathons
          </div>
        ) : hackathons.isError ? (
          <QueryErrorState
            title="Could not load hackathons"
            description="The JudgeBuddy API did not respond, so this list is unknown rather than empty. Check that the API is reachable and try again."
            error={hackathons.error}
            onRetry={() => void hackathons.refetch()}
            isRetrying={hackathons.isFetching}
          />
        ) : hackathons.data && hackathons.data.length > 0 ? (
          <div className="space-y-4">
            {hackathons.data.map((hackathon) => (
              <div key={hackathon.id} className="border border-border bg-card p-5">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-lg font-black text-foreground">{hackathon.name}</h3>
                      <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-accent">
                        {statusLabel[hackathon.status] ?? hackathon.status}
                      </span>
                    </div>
                    <p className="max-w-2xl text-sm text-muted-foreground">{hackathon.tagline}</p>
                    <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        Organizer
                        <div className="font-mono text-foreground">{hackathon.organizerAccountId}</div>
                      </div>
                      <div>
                        Judge
                        <div className="font-mono text-foreground">{hackathon.judgeAccountId}</div>
                      </div>
                      <div>
                        Submission deadline
                        <div className="font-mono text-foreground">{formatDateTime(hackathon.submissionDeadline)}</div>
                      </div>
                      <div>
                        Treasury tx
                        <div className="font-mono text-foreground">{shorten(hackathon.treasuryTxHash)}</div>
                      </div>
                    </div>
                  </div>

                  <div className="min-w-[260px] space-y-3 border border-border bg-background/40 p-4">
                    <div className="flex items-center gap-2">
                      <Trophy className="h-4 w-4 text-accent" />
                      <span className="text-sm font-bold text-foreground">Tracks</span>
                    </div>
                    <div className="space-y-2">
                      {hackathon.tracks.map((track) => (
                        <div key={track.id} className="flex items-start justify-between gap-3 text-sm">
                          <div>
                            <div className="font-medium text-foreground">{track.name}</div>
                            <div className="text-[11px] text-muted-foreground">{track.sponsorName}</div>
                          </div>
                          <div className="font-mono text-foreground">{formatTokenAmount(track.prizeAmount)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <Button variant="outline" asChild>
                    <Link to={`/hackathon/live?id=${encodeURIComponent(hackathon.id)}`}>View Detail</Link>
                  </Button>
                  <Button variant="outline" asChild>
                    <Link to={`/hackathon/submissions?h=${encodeURIComponent(hackathon.id)}`}>Submissions</Link>
                  </Button>
                  <Button variant="outline" asChild>
                    <Link to={`/hackathon/agents?h=${encodeURIComponent(hackathon.id)}`}>Operations</Link>
                  </Button>
                  <Button variant="ghost" asChild>
                    <Link to={`/hackathon/submit?h=${encodeURIComponent(hackathon.id)}`}>
                      Submit project
                      <ArrowRight className="ml-2 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            className="p-8"
            title="No hackathons exist yet"
            description="Create one, fund the treasury, and the rest of the workflow unlocks."
          />
        )}
      </section>
    </div>
  );
}
