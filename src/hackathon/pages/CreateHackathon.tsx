import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { createHackathonRequestSchema, type CreateHackathonRequest, type Track } from "@shared/treasury";
import { createHackathon } from "@/hackathon/api";
import {
  formatBaseUnits,
  formatDateInput,
  formatTokenAmount,
  parseTokenAmountToBaseUnits,
  PAYOUT_TOKEN_DECIMALS,
  PAYOUT_TOKEN_SYMBOL,
} from "@/hackathon/format";
import { useAuth } from "@/auth/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Draft shape for a track. `prizeAmountInput` is what the organizer types — a human
 * token amount such as `1000` or `1000.5`. It is converted to the integer base-unit
 * string the API expects only at submit time.
 */
type TrackDraft = Omit<Track, "prizeAmount"> & {
  prizeAmountInput: string;
  requirementsText: string;
};

type FieldErrors = Record<string, string>;

function defaultDate(offsetDays: number): string {
  const value = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return formatDateInput(value.toISOString());
}

function nextTrackId(existing: TrackDraft[]): string {
  const taken = new Set(existing.map((track) => track.id));
  let index = existing.length + 1;
  while (taken.has(`track-${index}`)) index += 1;
  return `track-${index}`;
}

function makeTrack(existing: TrackDraft[]): TrackDraft {
  return {
    id: nextTrackId(existing),
    name: "",
    description: "",
    sponsorName: "",
    prizeAmountInput: "1000",
    requirements: ["Public GitHub repository", "Working demo"],
    requirementsText: "Public GitHub repository\nWorking demo",
    evaluationPolicy: {
      minQualityScore: 75,
      requiresPublicRepo: true,
      requiresReadme: true,
      requiresDemo: true,
      requiresHashscanVerification: false,
      requiresContracts: false,
    },
  };
}

function toIsoOrNull(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-[11px] leading-5 text-destructive">{message}</p>;
}

export default function CreateHackathon() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { authenticated, openAuthDialog, user } = useAuth();

  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [judgeAccountId, setJudgeAccountId] = useState("");
  const [judgeEvmAddress, setJudgeEvmAddress] = useState("");
  const [payoutTokenId, setPayoutTokenId] = useState("");
  const [payoutTokenEvmAddress, setPayoutTokenEvmAddress] = useState("");
  const [autonomousThresholdInput, setAutonomousThresholdInput] = useState("1000");
  const [approvalExpirySeconds, setApprovalExpirySeconds] = useState("604800");
  const [startsAt, setStartsAt] = useState(defaultDate(1));
  const [submissionDeadline, setSubmissionDeadline] = useState(defaultDate(7));
  const [endsAt, setEndsAt] = useState(defaultDate(10));
  const [judgingEndsAt, setJudgingEndsAt] = useState(defaultDate(12));
  const [tracks, setTracks] = useState<TrackDraft[]>(() => [makeTrack([])]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // The session resolves asynchronously, so seeding these from `user` in `useState`
  // leaves them empty after sign-in. Sync once the user arrives, without overwriting
  // anything the organizer has already typed.
  useEffect(() => {
    if (!user) return;
    setJudgeAccountId((current) => current || user.accountId);
    setJudgeEvmAddress((current) => current || user.evmAddress);
  }, [user]);

  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const setFieldRef = (key: string) => (node: HTMLElement | null) => {
    if (node) fieldRefs.current.set(key, node);
    else fieldRefs.current.delete(key);
  };

  const trackBudgets = useMemo(
    () => tracks.map((track) => parseTokenAmountToBaseUnits(track.prizeAmountInput)),
    [tracks],
  );

  const totalBudgetBaseUnits = useMemo(
    () => trackBudgets.reduce((sum, amount) => (amount === null ? sum : sum + BigInt(amount)), 0n),
    [trackBudgets],
  );

  const autonomousThresholdBaseUnits = useMemo(
    () => parseTokenAmountToBaseUnits(autonomousThresholdInput),
    [autonomousThresholdInput],
  );

  const createMutation = useMutation({
    mutationFn: async (payload: CreateHackathonRequest) => createHackathon(payload),
    onSuccess: async (hackathon) => {
      toast.success("Hackathon created. Next step: fund the treasury on Hedera.");
      await queryClient.invalidateQueries({ queryKey: ["hackathons"] });
      navigate(`/hackathon/live?id=${encodeURIComponent(hackathon.id)}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not create hackathon");
    },
  });

  function updateTrack(index: number, updater: (track: TrackDraft) => TrackDraft) {
    setTracks((current) => current.map((track, trackIndex) => (trackIndex === index ? updater(track) : track)));
  }

  /**
   * Build the request and validate it with the shared server schema.
   * `payload` is non-null only when `errors` is empty.
   */
  function validate(): { errors: FieldErrors; payload: CreateHackathonRequest | null } {
    if (!user) {
      return { errors: { form: "Sign in as the organizer before creating a hackathon." }, payload: null };
    }

    const localErrors: FieldErrors = {};

    const startsAtIso = toIsoOrNull(startsAt);
    const endsAtIso = toIsoOrNull(endsAt);
    const submissionDeadlineIso = toIsoOrNull(submissionDeadline);
    const judgingEndsAtIso = toIsoOrNull(judgingEndsAt);
    if (!startsAtIso) localErrors.startsAt = "Enter a valid start date and time.";
    if (!endsAtIso) localErrors.endsAt = "Enter a valid end date and time.";
    if (!submissionDeadlineIso) localErrors.submissionDeadline = "Enter a valid submission deadline.";
    if (!judgingEndsAtIso) localErrors.judgingEndsAt = "Enter a valid judging end date and time.";

    if (autonomousThresholdBaseUnits === null) {
      localErrors.autonomousThreshold = `Enter a ${PAYOUT_TOKEN_SYMBOL} amount with at most ${PAYOUT_TOKEN_DECIMALS} decimal places.`;
    }

    const trackPayloads = tracks.map((track, index) => {
      const prizeAmount = trackBudgets[index];
      if (prizeAmount === null) {
        localErrors[`tracks.${index}.prizeAmount`] =
          `Enter a ${PAYOUT_TOKEN_SYMBOL} amount with at most ${PAYOUT_TOKEN_DECIMALS} decimal places.`;
      }
      const { prizeAmountInput: _prizeAmountInput, requirementsText, ...rest } = track;
      return {
        ...rest,
        prizeAmount: prizeAmount ?? "",
        requirements: requirementsText
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
      };
    });

    const candidate = {
      name,
      tagline,
      organizerAccountId: user.accountId,
      organizerEvmAddress: user.evmAddress,
      judgeAccountId,
      judgeEvmAddress,
      payoutTokenId,
      payoutTokenEvmAddress,
      autonomousThreshold: autonomousThresholdBaseUnits ?? "",
      approvalExpirySeconds: Number(approvalExpirySeconds),
      startsAt: startsAtIso ?? "",
      endsAt: endsAtIso ?? "",
      submissionDeadline: submissionDeadlineIso ?? "",
      judgingEndsAt: judgingEndsAtIso ?? "",
      tracks: trackPayloads,
    };

    const parsed = createHackathonRequestSchema.safeParse(candidate);
    const errors: FieldErrors = { ...localErrors };
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (!errors[key]) errors[key] = issue.message;
      }
    }

    if (Object.keys(errors).length || !parsed.success) {
      return { errors, payload: null };
    }

    return { errors: {}, payload: parsed.data };
  }

  function focusFirstInvalidField(errors: FieldErrors) {
    // `fieldRefs` is rebuilt in DOM order on every render, so the first match is the
    // topmost invalid field on screen.
    for (const [key, node] of fieldRefs.current) {
      if (errors[key]) {
        node.focus();
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
  }

  function handleSubmit() {
    if (!authenticated || !user) {
      toast.error("Sign in as the organizer before creating a hackathon.");
      openAuthDialog();
      return;
    }

    const { errors, payload } = validate();
    if (!payload) {
      setFieldErrors(errors);
      focusFirstInvalidField(errors);
      toast.error("Fix the highlighted fields before creating the hackathon.");
      return;
    }

    setFieldErrors({});
    createMutation.mutate(payload);
  }

  const invalid = (key: string) => Boolean(fieldErrors[key]);
  const invalidClass = (key: string) => (invalid(key) ? "border-destructive focus-visible:ring-destructive" : "");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="border border-border bg-card p-6">
        <div className="flex items-center gap-2 text-accent">
          <ShieldCheck className="h-4 w-4" />
          <span className="text-[10px] font-mono uppercase tracking-[0.3em]">Organizer Setup</span>
        </div>
        <h1 className="mt-3 text-2xl font-black tracking-tight text-foreground sm:text-3xl">Create a hackathon treasury</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          This writes the live event definition to Postgres and seeds the worker pipeline. The actual funds move only after you approve token spend and bootstrap the treasury on the detail page.
        </p>
      </div>

      {!authenticated || !user ? (
        <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
          Sign in with the organizer MetaMask account first.
          <div className="mt-3">
            <Button onClick={openAuthDialog}>Sign in</Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.05fr,0.95fr]">
        <section className="space-y-6">
          <div className="border border-border bg-card p-6">
            <h2 className="text-lg font-black text-foreground">Identity and treasury</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Organizer account</Label>
                <Input value={user?.accountId ?? ""} disabled className="font-mono" />
              </div>
              <div className="space-y-2">
                <Label>Organizer EVM</Label>
                <Input value={user?.evmAddress ?? ""} disabled className="font-mono" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="judgeAccountId">Judge account</Label>
                <Input
                  id="judgeAccountId"
                  ref={setFieldRef("judgeAccountId")}
                  value={judgeAccountId}
                  onChange={(event) => setJudgeAccountId(event.target.value)}
                  placeholder="0.0.x"
                  aria-invalid={invalid("judgeAccountId")}
                  className={cn("font-mono", invalidClass("judgeAccountId"))}
                />
                <FieldError message={fieldErrors.judgeAccountId} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="judgeEvmAddress">Judge EVM</Label>
                <Input
                  id="judgeEvmAddress"
                  ref={setFieldRef("judgeEvmAddress")}
                  value={judgeEvmAddress}
                  onChange={(event) => setJudgeEvmAddress(event.target.value)}
                  placeholder="0x..."
                  aria-invalid={invalid("judgeEvmAddress")}
                  className={cn("font-mono", invalidClass("judgeEvmAddress"))}
                />
                <FieldError message={fieldErrors.judgeEvmAddress} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payoutTokenId">Payout token id</Label>
                <Input
                  id="payoutTokenId"
                  ref={setFieldRef("payoutTokenId")}
                  value={payoutTokenId}
                  onChange={(event) => setPayoutTokenId(event.target.value)}
                  placeholder="0.0.x"
                  aria-invalid={invalid("payoutTokenId")}
                  className={cn("font-mono", invalidClass("payoutTokenId"))}
                />
                <FieldError message={fieldErrors.payoutTokenId} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payoutTokenEvmAddress">Payout token EVM address</Label>
                <Input
                  id="payoutTokenEvmAddress"
                  ref={setFieldRef("payoutTokenEvmAddress")}
                  value={payoutTokenEvmAddress}
                  onChange={(event) => setPayoutTokenEvmAddress(event.target.value)}
                  placeholder="0x..."
                  aria-invalid={invalid("payoutTokenEvmAddress")}
                  className={cn("font-mono", invalidClass("payoutTokenEvmAddress"))}
                />
                <FieldError message={fieldErrors.payoutTokenEvmAddress} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="autonomousThreshold">Autonomous payout threshold ({PAYOUT_TOKEN_SYMBOL})</Label>
                <Input
                  id="autonomousThreshold"
                  ref={setFieldRef("autonomousThreshold")}
                  value={autonomousThresholdInput}
                  onChange={(event) => setAutonomousThresholdInput(event.target.value)}
                  inputMode="decimal"
                  placeholder="1000"
                  aria-invalid={invalid("autonomousThreshold")}
                  className={cn("font-mono", invalidClass("autonomousThreshold"))}
                />
                <p className="text-[11px] leading-5 text-muted-foreground">
                  {autonomousThresholdBaseUnits !== null
                    ? `Sent as ${formatBaseUnits(autonomousThresholdBaseUnits)} base units (${PAYOUT_TOKEN_DECIMALS} decimals).`
                    : `Enter a ${PAYOUT_TOKEN_SYMBOL} amount, e.g. 1000 or 1000.50.`}
                </p>
                <FieldError message={fieldErrors.autonomousThreshold} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="approvalExpirySeconds">Approval expiry seconds</Label>
                <Input
                  id="approvalExpirySeconds"
                  ref={setFieldRef("approvalExpirySeconds")}
                  value={approvalExpirySeconds}
                  onChange={(event) => setApprovalExpirySeconds(event.target.value)}
                  inputMode="numeric"
                  aria-invalid={invalid("approvalExpirySeconds")}
                  className={cn("font-mono", invalidClass("approvalExpirySeconds"))}
                />
                <FieldError message={fieldErrors.approvalExpirySeconds} />
              </div>
            </div>
            <div className="mt-4">
              <Button
                variant="outline"
                onClick={() => {
                  if (!user) return;
                  setJudgeAccountId(user.accountId);
                  setJudgeEvmAddress(user.evmAddress);
                }}
                disabled={!user}
              >
                Use my wallet as judge
              </Button>
            </div>
          </div>

          <div className="border border-border bg-card p-6">
            <h2 className="text-lg font-black text-foreground">Schedule and messaging</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  ref={setFieldRef("name")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="ETHGlobal Cannes Treasury Tracks"
                  aria-invalid={invalid("name")}
                  className={invalidClass("name")}
                />
                <FieldError message={fieldErrors.name} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="tagline">Tagline</Label>
                <Textarea
                  id="tagline"
                  ref={setFieldRef("tagline")}
                  value={tagline}
                  onChange={(event) => setTagline(event.target.value)}
                  placeholder="Live treasury operations for Hedera, Ledger, and Naryo submissions."
                  aria-invalid={invalid("tagline")}
                  className={invalidClass("tagline")}
                />
                <FieldError message={fieldErrors.tagline} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="startsAt">Starts at</Label>
                <Input
                  id="startsAt"
                  ref={setFieldRef("startsAt")}
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                  aria-invalid={invalid("startsAt")}
                  className={invalidClass("startsAt")}
                />
                <FieldError message={fieldErrors.startsAt} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="submissionDeadline">Submission deadline</Label>
                <Input
                  id="submissionDeadline"
                  ref={setFieldRef("submissionDeadline")}
                  type="datetime-local"
                  value={submissionDeadline}
                  onChange={(event) => setSubmissionDeadline(event.target.value)}
                  aria-invalid={invalid("submissionDeadline")}
                  className={invalidClass("submissionDeadline")}
                />
                <FieldError message={fieldErrors.submissionDeadline} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endsAt">Hackathon ends</Label>
                <Input
                  id="endsAt"
                  ref={setFieldRef("endsAt")}
                  type="datetime-local"
                  value={endsAt}
                  onChange={(event) => setEndsAt(event.target.value)}
                  aria-invalid={invalid("endsAt")}
                  className={invalidClass("endsAt")}
                />
                <FieldError message={fieldErrors.endsAt} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="judgingEndsAt">Judging ends</Label>
                <Input
                  id="judgingEndsAt"
                  ref={setFieldRef("judgingEndsAt")}
                  type="datetime-local"
                  value={judgingEndsAt}
                  onChange={(event) => setJudgingEndsAt(event.target.value)}
                  aria-invalid={invalid("judgingEndsAt")}
                  className={invalidClass("judgingEndsAt")}
                />
                <FieldError message={fieldErrors.judgingEndsAt} />
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <div className="border border-border bg-card p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-black text-foreground">Tracks</h2>
                <p className="text-sm text-muted-foreground">Each track maps directly to a funded treasury budget and an evaluation policy.</p>
              </div>
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => setTracks((current) => [...current, makeTrack(current)])}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add track
              </Button>
            </div>

            <FieldError message={fieldErrors.tracks} />

            <div className="mt-5 space-y-4">
              {tracks.map((track, index) => {
                const baseUnits = trackBudgets[index];
                return (
                  <div key={track.id} className="border border-border bg-background/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-bold text-foreground">Track {index + 1}</h3>
                      {tracks.length > 1 ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove track ${index + 1}`}
                          onClick={() => setTracks((current) => current.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>

                    <div className="mt-4 space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor={`track-${index}-id`}>Track id</Label>
                        <Input
                          id={`track-${index}-id`}
                          ref={setFieldRef(`tracks.${index}.id`)}
                          value={track.id}
                          onChange={(event) => updateTrack(index, (current) => ({ ...current, id: event.target.value }))}
                          aria-invalid={invalid(`tracks.${index}.id`)}
                          className={cn("font-mono", invalidClass(`tracks.${index}.id`))}
                        />
                        <FieldError message={fieldErrors[`tracks.${index}.id`]} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`track-${index}-name`}>Name</Label>
                        <Input
                          id={`track-${index}-name`}
                          ref={setFieldRef(`tracks.${index}.name`)}
                          value={track.name}
                          onChange={(event) => updateTrack(index, (current) => ({ ...current, name: event.target.value }))}
                          aria-invalid={invalid(`tracks.${index}.name`)}
                          className={invalidClass(`tracks.${index}.name`)}
                        />
                        <FieldError message={fieldErrors[`tracks.${index}.name`]} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`track-${index}-sponsor`}>Sponsor name</Label>
                        <Input
                          id={`track-${index}-sponsor`}
                          ref={setFieldRef(`tracks.${index}.sponsorName`)}
                          value={track.sponsorName}
                          onChange={(event) => updateTrack(index, (current) => ({ ...current, sponsorName: event.target.value }))}
                          aria-invalid={invalid(`tracks.${index}.sponsorName`)}
                          className={invalidClass(`tracks.${index}.sponsorName`)}
                        />
                        <FieldError message={fieldErrors[`tracks.${index}.sponsorName`]} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`track-${index}-description`}>Description</Label>
                        <Textarea
                          id={`track-${index}-description`}
                          ref={setFieldRef(`tracks.${index}.description`)}
                          value={track.description}
                          onChange={(event) => updateTrack(index, (current) => ({ ...current, description: event.target.value }))}
                          aria-invalid={invalid(`tracks.${index}.description`)}
                          className={invalidClass(`tracks.${index}.description`)}
                        />
                        <FieldError message={fieldErrors[`tracks.${index}.description`]} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`track-${index}-prize`}>Prize amount ({PAYOUT_TOKEN_SYMBOL})</Label>
                        <Input
                          id={`track-${index}-prize`}
                          ref={setFieldRef(`tracks.${index}.prizeAmount`)}
                          value={track.prizeAmountInput}
                          onChange={(event) => updateTrack(index, (current) => ({ ...current, prizeAmountInput: event.target.value }))}
                          inputMode="decimal"
                          placeholder="1000"
                          aria-invalid={invalid(`tracks.${index}.prizeAmount`)}
                          className={cn("font-mono", invalidClass(`tracks.${index}.prizeAmount`))}
                        />
                        <p className="text-[11px] leading-5 text-muted-foreground">
                          {baseUnits !== null
                            ? `Sent as ${formatBaseUnits(baseUnits)} base units (${PAYOUT_TOKEN_DECIMALS} decimals).`
                            : `Enter a ${PAYOUT_TOKEN_SYMBOL} amount with at most ${PAYOUT_TOKEN_DECIMALS} decimal places.`}
                        </p>
                        <FieldError message={fieldErrors[`tracks.${index}.prizeAmount`]} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`track-${index}-requirements`}>Requirements (one per line)</Label>
                        <Textarea
                          id={`track-${index}-requirements`}
                          ref={setFieldRef(`tracks.${index}.requirements`)}
                          value={track.requirementsText}
                          onChange={(event) => updateTrack(index, (current) => ({ ...current, requirementsText: event.target.value }))}
                          aria-invalid={invalid(`tracks.${index}.requirements`)}
                          className={invalidClass(`tracks.${index}.requirements`)}
                        />
                        <FieldError message={fieldErrors[`tracks.${index}.requirements`]} />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor={`track-${index}-min-quality`}>Min quality score</Label>
                          <Input
                            id={`track-${index}-min-quality`}
                            ref={setFieldRef(`tracks.${index}.evaluationPolicy.minQualityScore`)}
                            value={String(track.evaluationPolicy.minQualityScore)}
                            onChange={(event) =>
                              updateTrack(index, (current) => ({
                                ...current,
                                evaluationPolicy: {
                                  ...current.evaluationPolicy,
                                  minQualityScore: Number(event.target.value || 0),
                                },
                              }))
                            }
                            inputMode="numeric"
                            aria-invalid={invalid(`tracks.${index}.evaluationPolicy.minQualityScore`)}
                            className={cn("font-mono", invalidClass(`tracks.${index}.evaluationPolicy.minQualityScore`))}
                          />
                          <FieldError message={fieldErrors[`tracks.${index}.evaluationPolicy.minQualityScore`]} />
                        </div>
                        {[
                          ["requiresPublicRepo", "Require public repo"],
                          ["requiresReadme", "Require README"],
                          ["requiresDemo", "Require demo"],
                          ["requiresContracts", "Require deployed contracts"],
                          ["requiresHashscanVerification", "Require HashScan verification"],
                        ].map(([field, label]) => (
                          <label key={field} className="flex items-center gap-2 text-sm text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={Boolean(track.evaluationPolicy[field as keyof typeof track.evaluationPolicy])}
                              onChange={(event) =>
                                updateTrack(index, (current) => ({
                                  ...current,
                                  evaluationPolicy: {
                                    ...current.evaluationPolicy,
                                    [field]: event.target.checked,
                                  },
                                }))
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border border-border bg-card p-6">
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground">Summary</p>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Tracks</span>
                <span className="font-mono text-foreground">{tracks.length}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Total prize budget</span>
                <span className="break-all text-right font-mono text-foreground">{formatTokenAmount(totalBudgetBaseUnits)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Total in base units</span>
                <span className="break-all text-right font-mono text-foreground">{formatBaseUnits(totalBudgetBaseUnits)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Judge signer</span>
                <span className="break-all text-right font-mono text-foreground">{judgeAccountId || "unset"}</span>
              </div>
            </div>
            <FieldError message={fieldErrors.form} />
            <Button className="mt-5 w-full" onClick={handleSubmit} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create hackathon"}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
