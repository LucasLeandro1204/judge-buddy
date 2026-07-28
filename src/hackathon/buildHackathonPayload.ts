import type { Hackathon, HackathonStatus } from "@/hackathon/types";
import { payoutTokenSymbol } from "@/hackathon/format";

export type TrackDraft = {
  name: string;
  description: string;
  prize: string;
  requirements: string[];
};

function slugPart(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "track"
  );
}

export function buildHackathonPayload(input: {
  name: string;
  tagline: string;
  startDate: string;
  endDate: string;
  tracks: TrackDraft[];
  autoEscrow: boolean;
  organizer?: string;
}): Hackathon {
  const now = Date.now() / 1000;
  const startSec = input.startDate ? Math.floor(new Date(input.startDate).getTime() / 1000) : now;
  const endSec = input.endDate ? Math.floor(new Date(input.endDate).getTime() / 1000) : now + 7 * 86400;

  let status: HackathonStatus = "upcoming";
  if (now >= endSec) status = "judging";
  else if (now >= startSec) status = "live";

  const id = `h-${crypto.randomUUID()}`;
  const prizePool = input.tracks.reduce((s, t) => s + (Number(t.prize) || 0), 0);

  const hexPreview = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    id,
    name: input.name.trim(),
    tagline: input.tagline.trim(),
    prizePool,
    prizeToken: payoutTokenSymbol() || "TOKEN",
    status,
    tracks: input.tracks.map((t, i) => ({
      id: `${slugPart(t.name)}-${i}`.slice(0, 48),
      name: t.name.trim(),
      description: t.description.trim(),
      prize: Number(t.prize) || 0,
      requirements: t.requirements.map((r) => r.trim()).filter(Boolean),
    })),
    startsAt: startSec,
    endsAt: endSec,
    submissionDeadline: endSec,
    judgingEndsAt: endSec + 7 * 86400,
    submissions: [],
    similarityClusters: undefined,
    escrowLocked: input.autoEscrow,
    escrowTxHash: input.autoEscrow ? `0x${hexPreview}…pending` : "",
    organizer: input.organizer?.trim() || "organizer",
  };
}
