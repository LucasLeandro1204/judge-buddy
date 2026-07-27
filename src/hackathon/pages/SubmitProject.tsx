import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { createSubmissionRequestSchema, type CreateSubmissionRequest } from "@shared/treasury";
import { createSubmission, fetchHackathons } from "@/hackathon/api";
import { QueryErrorState } from "@/hackathon/QueryStates";
import { useAuth } from "@/auth/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type ContractDraft = {
  /** Stable identity for the React key so the inputs are not remounted while typing. */
  key: string;
  label: string;
  address: string;
  hashscanUrl: string;
};

type FieldErrors = Record<string, string>;

let contractKeySeed = 0;
function makeContractDraft(): ContractDraft {
  contractKeySeed += 1;
  return { key: `contract-${contractKeySeed}`, label: "", address: "", hashscanUrl: "" };
}

function RequiredMark() {
  return (
    <span className="ml-1 text-destructive" aria-hidden="true">
      *
    </span>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-[11px] leading-5 text-destructive">{message}</p>;
}

export default function SubmitProject() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { authenticated, openAuthDialog, user } = useAuth();

  const hackathons = useQuery({
    queryKey: ["hackathons"],
    queryFn: fetchHackathons,
  });

  const initialHackathonId = params.get("h") ?? "";
  const [hackathonId, setHackathonId] = useState(initialHackathonId);
  const selectedHackathon = useMemo(
    () => hackathons.data?.find((entry) => entry.id === hackathonId) ?? hackathons.data?.[0],
    [hackathonId, hackathons.data],
  );
  const [trackId, setTrackId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamMembers, setTeamMembers] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [demoUrl, setDemoUrl] = useState("");
  const [description, setDescription] = useState("");
  const [payoutAccountId, setPayoutAccountId] = useState("");
  const [payoutEvmAddress, setPayoutEvmAddress] = useState("");
  const [contracts, setContracts] = useState<ContractDraft[]>(() => [makeContractDraft()]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const setFieldRef = (key: string) => (node: HTMLElement | null) => {
    if (node) fieldRefs.current.set(key, node);
    else fieldRefs.current.delete(key);
  };

  useEffect(() => {
    if (!hackathonId && selectedHackathon?.id) {
      setHackathonId(selectedHackathon.id);
      setParams({ h: selectedHackathon.id });
    }
  }, [hackathonId, selectedHackathon?.id, setParams]);

  useEffect(() => {
    if (!selectedHackathon) return;
    if (!selectedHackathon.tracks.some((track) => track.id === trackId)) {
      setTrackId(selectedHackathon.tracks[0]?.id ?? "");
    }
  }, [selectedHackathon, trackId]);

  useEffect(() => {
    if (user) {
      setPayoutAccountId((current) => current || user.accountId);
      setPayoutEvmAddress((current) => current || user.evmAddress);
    }
  }, [user]);

  const submitMutation = useMutation({
    mutationFn: async (payload: CreateSubmissionRequest) => createSubmission(payload),
    onSuccess: async ({ submission }) => {
      toast.success("Submission stored and evaluation job queued.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["hackathon", submission.hackathonId] }),
        queryClient.invalidateQueries({ queryKey: ["hackathons"] }),
      ]);
      navigate(`/hackathon/submissions?h=${encodeURIComponent(submission.hackathonId)}&id=${encodeURIComponent(submission.id)}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not submit project");
    },
  });

  function updateContract(index: number, key: keyof Omit<ContractDraft, "key">, value: string) {
    setContracts((current) => current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, [key]: value } : entry)));
  }

  /** Validate against the same schema the server enforces. `payload` is non-null only when `errors` is empty. */
  function validate(): { errors: FieldErrors; payload: CreateSubmissionRequest | null } {
    if (!selectedHackathon) {
      return { errors: { hackathonId: "Select a hackathon first." }, payload: null };
    }

    const populatedContracts = contracts.filter((entry) => entry.label.trim() || entry.address.trim() || entry.hashscanUrl.trim());

    const candidate = {
      hackathonId: selectedHackathon.id,
      trackId,
      projectName,
      teamName,
      teamMembers: teamMembers
        .split(/\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean),
      githubUrl,
      demoUrl,
      description,
      payoutAccountId,
      payoutEvmAddress,
      deployedContracts: populatedContracts.map((entry) => ({
        label: entry.label.trim(),
        address: entry.address.trim(),
        hashscanUrl: entry.hashscanUrl.trim() || undefined,
      })),
    };

    const parsed = createSubmissionRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        // Schema indices refer to the filtered contract list; map them back to the rendered rows.
        const path = issue.path.slice();
        if (path[0] === "deployedContracts" && typeof path[1] === "number") {
          const source = populatedContracts[path[1]];
          const renderedIndex = contracts.findIndex((entry) => entry.key === source?.key);
          if (renderedIndex >= 0) path[1] = renderedIndex;
        }
        const key = path.join(".");
        if (!errors[key]) errors[key] = issue.message;
      }
      return { errors, payload: null };
    }

    return { errors: {}, payload: parsed.data };
  }

  function focusFirstInvalidField(errors: FieldErrors) {
    for (const [key, node] of fieldRefs.current) {
      if (errors[key]) {
        node.focus();
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
  }

  function handleSubmit() {
    const { errors, payload } = validate();
    if (!payload) {
      setFieldErrors(errors);
      focusFirstInvalidField(errors);
      toast.error("Fix the highlighted fields before submitting.");
      return;
    }

    setFieldErrors({});
    submitMutation.mutate(payload);
  }

  const invalid = (key: string) => Boolean(fieldErrors[key]);
  const invalidClass = (key: string) => (invalid(key) ? "border-destructive focus-visible:ring-destructive" : "");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Dashboard
      </Link>

      <div className="border border-border bg-card p-6">
        <h1 className="text-2xl font-black tracking-tight text-foreground sm:text-3xl">Submit a project</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          This creates the submission record the worker will evaluate against sponsor policy, GitHub evidence, demo availability, and deployed contract proofs.
        </p>
      </div>

      {hackathons.isError ? (
        <QueryErrorState
          title="Could not load hackathons"
          description="The event list could not be fetched, so there is nothing to submit against. This is an API failure, not an empty schedule."
          error={hackathons.error}
          onRetry={() => void hackathons.refetch()}
          isRetrying={hackathons.isFetching}
        />
      ) : null}

      {!authenticated || !user ? (
        <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
          Sign in if you want JudgeBuddy to prefill your payout account and MetaMask address.
          <div className="mt-3">
            <Button onClick={openAuthDialog}>Sign in</Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.05fr,0.95fr]">
        <section className="space-y-6">
          <div className="border border-border bg-card p-6">
            <h2 className="text-lg font-black text-foreground">Submission basics</h2>
            <div className="mt-4 grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="hackathon">Hackathon</Label>
                <select
                  id="hackathon"
                  value={selectedHackathon?.id ?? ""}
                  onChange={(event) => {
                    setHackathonId(event.target.value);
                    setParams({ h: event.target.value });
                  }}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {(hackathons.data ?? []).map((hackathon) => (
                    <option key={hackathon.id} value={hackathon.id}>
                      {hackathon.name}
                    </option>
                  ))}
                </select>
                <FieldError message={fieldErrors.hackathonId} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="track">Track</Label>
                <select
                  id="track"
                  value={trackId}
                  onChange={(event) => setTrackId(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {(selectedHackathon?.tracks ?? []).map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.name}
                    </option>
                  ))}
                </select>
                <FieldError message={fieldErrors.trackId} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="projectName">
                  Project name
                  <RequiredMark />
                </Label>
                <Input
                  id="projectName"
                  ref={setFieldRef("projectName")}
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="JudgeBuddy Treasury"
                  aria-invalid={invalid("projectName")}
                  className={invalidClass("projectName")}
                />
                <FieldError message={fieldErrors.projectName} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="teamName">
                  Team name
                  <RequiredMark />
                </Label>
                <Input
                  id="teamName"
                  ref={setFieldRef("teamName")}
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                  placeholder="Team Ledger Hedera"
                  aria-invalid={invalid("teamName")}
                  className={invalidClass("teamName")}
                />
                <FieldError message={fieldErrors.teamName} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="teamMembers">Team members</Label>
                <Textarea
                  id="teamMembers"
                  ref={setFieldRef("teamMembers")}
                  value={teamMembers}
                  onChange={(event) => setTeamMembers(event.target.value)}
                  placeholder="One member per line or comma-separated"
                />
                <FieldError message={fieldErrors.teamMembers} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="githubUrl">
                  GitHub URL
                  <RequiredMark />
                </Label>
                <Input
                  id="githubUrl"
                  ref={setFieldRef("githubUrl")}
                  type="url"
                  value={githubUrl}
                  onChange={(event) => setGithubUrl(event.target.value)}
                  placeholder="https://github.com/org/repo"
                  aria-invalid={invalid("githubUrl")}
                  className={cn("font-mono", invalidClass("githubUrl"))}
                />
                <FieldError message={fieldErrors.githubUrl} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="demoUrl">
                  Demo URL
                  <RequiredMark />
                </Label>
                <Input
                  id="demoUrl"
                  ref={setFieldRef("demoUrl")}
                  type="url"
                  value={demoUrl}
                  onChange={(event) => setDemoUrl(event.target.value)}
                  placeholder="https://demo.example.com"
                  aria-invalid={invalid("demoUrl")}
                  className={cn("font-mono", invalidClass("demoUrl"))}
                />
                <p className="text-[11px] leading-5 text-muted-foreground">
                  Required. Sponsor policy checks fetch this URL, so it must be a reachable link.
                </p>
                <FieldError message={fieldErrors.demoUrl} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">
                  Description
                  <RequiredMark />
                </Label>
                <Textarea
                  id="description"
                  ref={setFieldRef("description")}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Explain the product, the sponsor fit, and what on-chain proof exists today."
                  aria-invalid={invalid("description")}
                  className={invalidClass("description")}
                />
                <FieldError message={fieldErrors.description} />
              </div>
            </div>
          </div>

          <div className="border border-border bg-card p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-black text-foreground">Deployed contracts</h2>
                <p className="text-sm text-muted-foreground">Include every live contract relevant to sponsor qualification. Add a HashScan URL whenever you have one.</p>
              </div>
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => setContracts((current) => [...current, makeContractDraft()])}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add contract
              </Button>
            </div>

            <div className="mt-5 space-y-4">
              {contracts.map((entry, index) => (
                <div key={entry.key} className="border border-border bg-background/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-bold text-foreground">Contract {index + 1}</h3>
                    {contracts.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove contract ${index + 1}`}
                        onClick={() => setContracts((current) => current.filter((_, i) => i !== index))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-4 grid gap-4">
                    <div className="space-y-2">
                      <Label htmlFor={`${entry.key}-label`}>Label</Label>
                      <Input
                        id={`${entry.key}-label`}
                        ref={setFieldRef(`deployedContracts.${index}.label`)}
                        value={entry.label}
                        onChange={(event) => updateContract(index, "label", event.target.value)}
                        placeholder="HackathonTreasury"
                        aria-invalid={invalid(`deployedContracts.${index}.label`)}
                        className={invalidClass(`deployedContracts.${index}.label`)}
                      />
                      <FieldError message={fieldErrors[`deployedContracts.${index}.label`]} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`${entry.key}-address`}>Address</Label>
                      <Input
                        id={`${entry.key}-address`}
                        ref={setFieldRef(`deployedContracts.${index}.address`)}
                        value={entry.address}
                        onChange={(event) => updateContract(index, "address", event.target.value)}
                        placeholder="0x..."
                        aria-invalid={invalid(`deployedContracts.${index}.address`)}
                        className={cn("font-mono", invalidClass(`deployedContracts.${index}.address`))}
                      />
                      <FieldError message={fieldErrors[`deployedContracts.${index}.address`]} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`${entry.key}-hashscan`}>HashScan URL</Label>
                      <Input
                        id={`${entry.key}-hashscan`}
                        ref={setFieldRef(`deployedContracts.${index}.hashscanUrl`)}
                        value={entry.hashscanUrl}
                        onChange={(event) => updateContract(index, "hashscanUrl", event.target.value)}
                        placeholder="https://hashscan.io/testnet/contract/..."
                        aria-invalid={invalid(`deployedContracts.${index}.hashscanUrl`)}
                        className={cn("font-mono", invalidClass(`deployedContracts.${index}.hashscanUrl`))}
                      />
                      <FieldError message={fieldErrors[`deployedContracts.${index}.hashscanUrl`]} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <div className="border border-border bg-card p-6">
            <h2 className="text-lg font-black text-foreground">Payout destination</h2>
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="payoutAccountId">
                  Payout account id
                  <RequiredMark />
                </Label>
                <Input
                  id="payoutAccountId"
                  ref={setFieldRef("payoutAccountId")}
                  value={payoutAccountId}
                  onChange={(event) => setPayoutAccountId(event.target.value)}
                  placeholder="0.0.x"
                  aria-invalid={invalid("payoutAccountId")}
                  className={cn("font-mono", invalidClass("payoutAccountId"))}
                />
                <FieldError message={fieldErrors.payoutAccountId} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payoutEvmAddress">
                  Payout EVM address
                  <RequiredMark />
                </Label>
                <Input
                  id="payoutEvmAddress"
                  ref={setFieldRef("payoutEvmAddress")}
                  value={payoutEvmAddress}
                  onChange={(event) => setPayoutEvmAddress(event.target.value)}
                  placeholder="0x..."
                  aria-invalid={invalid("payoutEvmAddress")}
                  className={cn("font-mono", invalidClass("payoutEvmAddress"))}
                />
                <FieldError message={fieldErrors.payoutEvmAddress} />
              </div>
              {user ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setPayoutAccountId(user.accountId);
                    setPayoutEvmAddress(user.evmAddress);
                  }}
                >
                  Use my signed-in wallet
                </Button>
              ) : null}
            </div>
          </div>

          <div className="border border-border bg-card p-6">
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground">What happens next</p>
            <div className="mt-4 space-y-3 text-sm text-muted-foreground">
              <p>1. The submission is stored in Postgres with full payout and contract metadata.</p>
              <p>2. The worker enqueues eligibility, track-fit, and quality analysis.</p>
              <p>3. If the score clears the track threshold, JudgeBuddy proposes an award and either pays autonomously or opens an approval request.</p>
            </div>
            <Button className="mt-5 w-full" onClick={handleSubmit} disabled={submitMutation.isPending}>
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Submitting
                </>
              ) : (
                "Submit project"
              )}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
