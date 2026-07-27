/**
 * Cloudflare D1 (SQLite) port of `server/src/store.ts`.
 *
 * Every exported function keeps the name, parameter shape and return shape of the Postgres
 * original; the only signature change is the leading `db: D1Database` parameter.
 *
 * Porting notes:
 *  - `numeric(78,0)` columns are TEXT. They are read back with `String(...)` and never coerced
 *    to a JS number, so uint256 base units stay exact.
 *  - `timestamptz` columns are TEXT holding ISO-8601 UTC strings. Anything the SQL compares
 *    against (`run_after`, `lease_expires_at`) is produced by `nowIso()` in JS and bound as a
 *    parameter, so comparisons stay lexicographic over one canonical format. SQLite's own
 *    `datetime()`/`strftime()` is never used inside a comparison.
 *  - `jsonb` columns are TEXT: `JSON.stringify` on the way in, `parseJson` on the way out.
 *  - D1 has no interactive transactions, so the three functions that used `begin`/`commit`
 *    (`createHackathon`, `markHackathonFunded`, `claimNextJob`) are rewritten around
 *    `db.batch([...])` (one implicit transaction, statements applied in order) or around a
 *    single atomic conditional `UPDATE ... RETURNING`.
 */

import {
  type ApprovalRequest,
  type AwardProposal,
  type CreateHackathonRequest,
  type CreateSubmissionRequest,
  type EventEnvelope,
  type EvaluationRun,
  type HackathonRecord,
  type PrizeClaim,
  type SubmissionRecord,
  type Track,
  makeId,
  sponsorPolicySchema,
} from "../../../packages/shared/src/index.js";

/** A D1 result row. Mirrors pg's `QueryResultRow` (`{ [column: string]: any }`). */
type Row = Record<string, any>;

const JOB_LEASE_MS = 5 * 60 * 1000;
const JOB_MAX_ATTEMPTS = 3;
const JOB_RETRY_BACKOFF_MS = 30 * 1000;

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Replacement for Postgres `now()`: an ISO-8601 UTC string, bound as a parameter. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Replacement for `now() + interval '<n> ms'`. */
function isoPlusMs(ms: number, from: number = Date.now()): string {
  return new Date(from + ms).toISOString();
}

/**
 * Parses a JSON column. Never throws: malformed, empty or already-decoded values fall back
 * to `fallback` (or are passed through when D1 handed us a decoded object).
 */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    return (parsed === null ? fallback : (parsed as T));
  } catch {
    return fallback;
  }
}

/**
 * Builds an `in (?,?,?)` fragment for what used to be `= any($1::text[])`.
 * An empty list yields a predicate that matches nothing instead of invalid SQL.
 */
function inClause(column: string, values: readonly unknown[]): { sql: string; params: unknown[] } {
  if (values.length === 0) return { sql: "1 = 0", params: [] };
  return { sql: `${column} in (${values.map(() => "?").join(",")})`, params: [...values] };
}

function statement(db: D1Database, sql: string, params: readonly unknown[] = []) {
  const prepared = db.prepare(sql);
  return params.length ? prepared.bind(...params) : prepared;
}

async function all(db: D1Database, sql: string, params: readonly unknown[] = []): Promise<Row[]> {
  const result = await statement(db, sql, params).all<Row>();
  return result.results ?? [];
}

async function first(db: D1Database, sql: string, params: readonly unknown[] = []): Promise<Row | null> {
  return (await statement(db, sql, params).first<Row>()) ?? null;
}

async function run(db: D1Database, sql: string, params: readonly unknown[] = []): Promise<void> {
  await statement(db, sql, params).run();
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

/* -------------------------------------------------------------------------- */
/* row mappers                                                                 */
/* -------------------------------------------------------------------------- */

function computeHackathonStatus(row: Row): HackathonRecord["status"] {
  const now = Date.now();
  const endsAt = new Date(row.ends_at).getTime();
  const judgingEndsAt = new Date(row.judging_ends_at).getTime();
  if (!row.treasury_tx_hash) return "funding";
  if (now >= judgingEndsAt) return "completed";
  if (now >= endsAt) return "judging";
  return "live";
}

function mapTrack(row: Row): Track {
  const rawRequirements = parseJson<unknown>(row.requirements, []);
  const requirements = Array.isArray(rawRequirements) ? rawRequirements.map((item: unknown) => String(item)) : [];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sponsorName: row.sponsor_name,
    prizeAmount: String(row.prize_amount),
    requirements,
    evaluationPolicy: sponsorPolicySchema.parse(parseJson<Record<string, unknown>>(row.evaluation_policy, {})),
  };
}

function mapHackathon(row: Row, tracks: Track[]): HackathonRecord {
  return {
    id: row.id,
    name: row.name,
    tagline: row.tagline,
    organizerAccountId: row.organizer_account_id,
    organizerEvmAddress: row.organizer_evm_address,
    judgeAccountId: row.judge_account_id,
    judgeEvmAddress: row.judge_evm_address,
    payoutTokenId: row.payout_token_id,
    payoutTokenEvmAddress: row.payout_token_evm_address,
    autonomousThreshold: String(row.autonomous_threshold),
    approvalExpirySeconds: Number(row.approval_expiry_seconds),
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    submissionDeadline: new Date(row.submission_deadline).toISOString(),
    judgingEndsAt: new Date(row.judging_ends_at).toISOString(),
    status: computeHackathonStatus(row),
    treasuryTxHash: row.treasury_tx_hash ?? null,
    tracks,
  };
}

function mapEvaluationRun(row: Row): EvaluationRun {
  return {
    id: row.id,
    submissionId: row.submission_id,
    agentRole: row.agent_role,
    status: row.status,
    result: parseJson<Record<string, any> | null>(row.result, null),
    error: row.error ?? null,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
  };
}

function mapAward(row: Row | undefined | null): AwardProposal | null {
  if (!row) return null;
  return {
    id: row.id,
    hackathonId: row.hackathon_id,
    submissionId: row.submission_id,
    trackId: row.track_id,
    winnerAccountId: row.winner_account_id,
    winnerEvmAddress: row.winner_evm_address,
    amount: String(row.amount),
    settlementMode: row.settlement_mode,
    status: row.status,
    reason: row.reason,
    machinePolicy: parseJson<Record<string, any>>(row.machine_policy, {}),
    digest: row.digest ?? null,
    txHash: row.tx_hash ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapClaim(row: Row | undefined | null): PrizeClaim | null {
  if (!row) return null;
  return {
    id: row.id,
    awardId: row.award_id,
    claimantAccountId: row.claimant_account_id,
    claimantEvmAddress: row.claimant_evm_address,
    tokenAddress: row.token_address ?? null,
    serialNumber: row.serial_number ?? null,
    metadataURI: row.metadata_uri ?? null,
    status: row.status,
    mintedTxHash: row.minted_tx_hash ?? null,
    redeemedTxHash: row.redeemed_tx_hash ?? null,
  };
}

function mapApproval(row: Row): ApprovalRequest {
  return {
    id: row.id,
    awardId: row.award_id,
    actionType: row.action_type,
    signerAccountId: row.signer_account_id,
    signerEvmAddress: row.signer_evm_address,
    status: row.status,
    typedData: parseJson<Record<string, any>>(row.typed_data, {}),
    clearSigningManifest: parseJson<Record<string, any>>(row.clear_signing_manifest, {}),
    signature: row.signature ?? null,
    expiresAt: new Date(row.expires_at).toISOString(),
    approvedAt: toIso(row.approved_at),
    executedAt: toIso(row.executed_at),
  };
}

function mapEventAuditType(eventType: string): string | null {
  switch (eventType) {
    case "hackathon.created":
      return "hackathon_created";
    case "treasury.funded":
      return "treasury_funded";
    case "submission.created":
      return "submission_created";
    case "award.approved":
      return "award_approved";
    case "claim.redeemed":
      return "claim_redeemed";
    default:
      return null;
  }
}

function makeAuditLookupKey(input: {
  type: string;
  hackathonId?: string | null;
  submissionId?: string | null;
  awardId?: string | null;
}): string {
  return [input.type, input.hackathonId ?? "", input.submissionId ?? "", input.awardId ?? ""].join("|");
}

/**
 * The Postgres original resolved the sentinel topic id "configured" through the
 * `HCS_TOPIC_ID` env var. Workers have no `process.env`, and the store takes no extra
 * parameters, so the sentinel resolves to `null` (identical to an unset `HCS_TOPIC_ID`).
 */
function normalizeAuditTopicId(topicId: string | null | undefined): string | null {
  if (!topicId) return null;
  if (topicId === "configured") return null;
  return topicId;
}

/* -------------------------------------------------------------------------- */
/* hackathons                                                                  */
/* -------------------------------------------------------------------------- */

export async function listHackathons(db: D1Database): Promise<HackathonRecord[]> {
  const hacks = await all(db, "select * from hackathons order by created_at desc");
  if (hacks.length === 0) return [];
  const ids = hacks.map((row) => String(row.id));
  const scope = inClause("hackathon_id", ids);
  const trackRows = await all(db, `select * from tracks where ${scope.sql} order by created_at asc`, scope.params);
  const tracksByHackathon = new Map<string, Track[]>();
  for (const row of trackRows) {
    const next = tracksByHackathon.get(row.hackathon_id) ?? [];
    next.push(mapTrack(row));
    tracksByHackathon.set(row.hackathon_id, next);
  }
  return hacks.map((row) => mapHackathon(row, tracksByHackathon.get(String(row.id)) ?? []));
}

export async function getHackathon(db: D1Database, id: string): Promise<HackathonRecord | null> {
  const hack = await first(db, "select * from hackathons where id = ?", [id]);
  if (!hack) return null;
  const tracks = await all(db, "select * from tracks where hackathon_id = ? order by created_at asc", [id]);
  return mapHackathon(hack, tracks.map(mapTrack));
}

export async function createHackathon(db: D1Database, input: CreateHackathonRequest): Promise<HackathonRecord> {
  const hackathonId = makeId("hackathon");
  const statements: D1PreparedStatement[] = [
    statement(
      db,
      `insert into hackathons (
        id, name, tagline, organizer_account_id, organizer_evm_address, judge_account_id, judge_evm_address,
        payout_token_id, payout_token_evm_address, autonomous_threshold, approval_expiry_seconds,
        starts_at, ends_at, submission_deadline, judging_ends_at, treasury_contract_address
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hackathonId,
        input.name,
        input.tagline,
        input.organizerAccountId,
        input.organizerEvmAddress,
        input.judgeAccountId,
        input.judgeEvmAddress,
        input.payoutTokenId,
        input.payoutTokenEvmAddress,
        input.autonomousThreshold,
        input.approvalExpirySeconds,
        input.startsAt,
        input.endsAt,
        input.submissionDeadline,
        input.judgingEndsAt,
        null,
      ],
    ),
  ];

  for (const track of input.tracks) {
    statements.push(
      statement(
        db,
        `insert into tracks (id, hackathon_id, name, description, sponsor_name, prize_amount, requirements, evaluation_policy)
         values (?,?,?,?,?,?,?,?)`,
        [
          track.id,
          hackathonId,
          track.name,
          track.description,
          track.sponsorName,
          track.prizeAmount,
          JSON.stringify(track.requirements),
          JSON.stringify(track.evaluationPolicy),
        ],
      ),
    );
  }

  // D1 applies a batch as a single transaction, in order, and rolls the whole batch back on error.
  await db.batch(statements);

  const created = await getHackathon(db, hackathonId);
  if (!created) throw new Error("Failed to load created hackathon");
  return created;
}

export async function markHackathonFunded(
  db: D1Database,
  params: {
    hackathonId: string;
    txHash: string;
    sponsorAccountId: string;
    sponsorEvmAddress: string;
    tokenId: string;
    deposits: Array<{ trackId: string; amount: string }>;
  },
): Promise<void> {
  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    statement(db, "update hackathons set treasury_tx_hash = ?, updated_at = ? where id = ?", [
      params.txHash,
      now,
      params.hackathonId,
    ]),
  ];

  for (const deposit of params.deposits) {
    statements.push(
      statement(
        db,
        `insert into sponsor_deposits (
          id, hackathon_id, track_id, sponsor_account_id, sponsor_evm_address, token_id, amount, tx_hash, status, metadata
        ) values (?,?,?,?,?,?,?,?,'confirmed',?)`,
        [
          makeId("deposit"),
          params.hackathonId,
          deposit.trackId,
          params.sponsorAccountId,
          params.sponsorEvmAddress,
          params.tokenId,
          deposit.amount,
          params.txHash,
          JSON.stringify({ source: "bootstrap" }),
        ],
      ),
    );
  }

  await db.batch(statements);
}

/* -------------------------------------------------------------------------- */
/* submissions                                                                 */
/* -------------------------------------------------------------------------- */

export async function createSubmission(db: D1Database, input: CreateSubmissionRequest): Promise<SubmissionRecord> {
  const id = makeId("submission");
  await run(
    db,
    `insert into submissions (
      id, hackathon_id, track_id, project_name, team_name, team_members, github_url, demo_url, description,
      payout_account_id, payout_evm_address, deployed_contracts, status
    ) values (?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
    [
      id,
      input.hackathonId,
      input.trackId,
      input.projectName,
      input.teamName,
      JSON.stringify(input.teamMembers),
      input.githubUrl,
      input.demoUrl,
      input.description,
      input.payoutAccountId,
      input.payoutEvmAddress,
      JSON.stringify(input.deployedContracts),
    ],
  );
  const submission = await getSubmission(db, id);
  if (!submission) throw new Error("Failed to load submission");
  return submission;
}

export async function listSubmissions(db: D1Database, hackathonId: string): Promise<SubmissionRecord[]> {
  const submissions = await all(db, "select * from submissions where hackathon_id = ? order by created_at desc", [
    hackathonId,
  ]);
  return Promise.all(submissions.map((row) => hydrateSubmission(db, String(row.id))));
}

export async function getSubmission(db: D1Database, id: string): Promise<SubmissionRecord | null> {
  const row = await first(db, "select * from submissions where id = ?", [id]);
  if (!row) return null;
  return hydrateSubmission(db, id);
}

async function hydrateSubmission(db: D1Database, id: string): Promise<SubmissionRecord> {
  const row = await first(db, "select * from submissions where id = ?", [id]);
  const runRows = await all(db, "select * from evaluation_runs where submission_id = ? order by created_at asc", [id]);
  const awardRow = await first(
    db,
    "select * from award_proposals where submission_id = ? order by created_at desc limit 1",
    [id],
  );
  const claimRow = awardRow
    ? await first(db, "select * from prize_claims where award_id = ? limit 1", [awardRow.id])
    : null;

  if (!row) throw new Error("Failed to load submission");

  return {
    id: row.id,
    hackathonId: row.hackathon_id,
    trackId: row.track_id,
    projectName: row.project_name,
    teamName: row.team_name,
    teamMembers: parseJson<string[]>(row.team_members, []),
    githubUrl: row.github_url,
    demoUrl: row.demo_url,
    description: row.description,
    payoutAccountId: row.payout_account_id,
    payoutEvmAddress: row.payout_evm_address,
    deployedContracts: parseJson<SubmissionRecord["deployedContracts"]>(row.deployed_contracts, []),
    status: row.status,
    evaluationRuns: runRows.map(mapEvaluationRun),
    awardProposal: mapAward(awardRow),
    claim: mapClaim(claimRow),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function updateSubmissionStatus(
  db: D1Database,
  id: string,
  status: SubmissionRecord["status"],
): Promise<void> {
  await run(db, "update submissions set status = ?, updated_at = ? where id = ?", [status, nowIso(), id]);
}

/* -------------------------------------------------------------------------- */
/* evaluation runs                                                             */
/* -------------------------------------------------------------------------- */

export async function createEvaluationRun(
  db: D1Database,
  params: {
    submissionId: string;
    agentRole: EvaluationRun["agentRole"];
    status: EvaluationRun["status"];
    result?: Record<string, unknown> | null;
    error?: string | null;
  },
): Promise<void> {
  const now = nowIso();
  // Postgres computed these with `case when $4 = 'running' then now() ...`; a positional
  // placeholder cannot be reused, so the branch is evaluated in JS instead.
  const startedAt = params.status === "running" ? now : null;
  const completedAt = params.status === "completed" || params.status === "failed" ? now : null;
  await run(
    db,
    `insert into evaluation_runs (id, submission_id, agent_role, status, result, error, started_at, completed_at)
     values (?,?,?,?,?,?,?,?)`,
    [
      makeId("run"),
      params.submissionId,
      params.agentRole,
      params.status,
      params.result === null || params.result === undefined ? null : JSON.stringify(params.result),
      params.error ?? null,
      startedAt,
      completedAt,
    ],
  );
}

export async function replaceLatestEvaluationRun(
  db: D1Database,
  params: {
    submissionId: string;
    agentRole: EvaluationRun["agentRole"];
    status: EvaluationRun["status"];
    result?: Record<string, unknown> | null;
    error?: string | null;
    model?: string | null;
  },
): Promise<void> {
  const now = nowIso();
  const completedAt = params.status === "completed" || params.status === "failed" ? now : null;
  await db.batch([
    statement(db, "delete from evaluation_runs where submission_id = ? and agent_role = ?", [
      params.submissionId,
      params.agentRole,
    ]),
    statement(
      db,
      `insert into evaluation_runs (id, submission_id, agent_role, status, result, error, model, started_at, completed_at)
       values (?,?,?,?,?,?,?,?,?)`,
      [
        makeId("run"),
        params.submissionId,
        params.agentRole,
        params.status,
        params.result === null || params.result === undefined ? null : JSON.stringify(params.result),
        params.error ?? null,
        params.model ?? null,
        now,
        completedAt,
      ],
    ),
  ]);
}

/* -------------------------------------------------------------------------- */
/* award proposals                                                             */
/* -------------------------------------------------------------------------- */

export async function createAwardProposal(
  db: D1Database,
  params: {
    hackathonId: string;
    submissionId: string;
    trackId: string;
    winnerAccountId: string;
    winnerEvmAddress: string;
    amount: string;
    settlementMode: AwardProposal["settlementMode"];
    status: AwardProposal["status"];
    reason: string;
    machinePolicy: Record<string, unknown>;
    digest?: string | null;
    txHash?: string | null;
  },
): Promise<AwardProposal> {
  const id = makeId("award");
  await run(
    db,
    `insert into award_proposals (
      id, hackathon_id, submission_id, track_id, winner_account_id, winner_evm_address, amount, settlement_mode,
      status, reason, machine_policy, digest, tx_hash
    ) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      params.hackathonId,
      params.submissionId,
      params.trackId,
      params.winnerAccountId,
      params.winnerEvmAddress,
      params.amount,
      params.settlementMode,
      params.status,
      params.reason,
      JSON.stringify(params.machinePolicy),
      params.digest ?? null,
      params.txHash ?? null,
    ],
  );
  const row = await first(db, "select * from award_proposals where id = ?", [id]);
  return mapAward(row)!;
}

export async function getAwardProposal(db: D1Database, id: string): Promise<AwardProposal | null> {
  const row = await first(db, "select * from award_proposals where id = ?", [id]);
  return mapAward(row);
}

export async function updateAwardProposal(
  db: D1Database,
  params: {
    id: string;
    status?: AwardProposal["status"];
    digest?: string | null;
    txHash?: string | null;
    reason?: string;
  },
): Promise<void> {
  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [nowIso()];
  if (params.status) {
    fields.push("status = ?");
    values.push(params.status);
  }
  if (params.digest !== undefined) {
    fields.push("digest = ?");
    values.push(params.digest);
  }
  if (params.txHash !== undefined) {
    fields.push("tx_hash = ?");
    values.push(params.txHash);
  }
  if (params.reason !== undefined) {
    fields.push("reason = ?");
    values.push(params.reason);
  }
  // Positional placeholders bind in textual order: every `set` value first, then the `where` id.
  values.push(params.id);
  await run(db, `update award_proposals set ${fields.join(", ")} where id = ?`, values);
}

/* -------------------------------------------------------------------------- */
/* approval requests                                                           */
/* -------------------------------------------------------------------------- */

export async function listApprovalRequests(db: D1Database, hackathonId?: string): Promise<ApprovalRequest[]> {
  const rows = hackathonId
    ? await all(
        db,
        `select ar.* from approval_requests ar
         join award_proposals ap on ap.id = ar.award_id
         where ap.hackathon_id = ?
         order by ar.created_at desc`,
        [hackathonId],
      )
    : await all(db, "select * from approval_requests order by created_at desc");
  return rows.map(mapApproval);
}

export async function createApprovalRequest(
  db: D1Database,
  params: {
    awardId: string;
    actionType: ApprovalRequest["actionType"];
    signerAccountId: string;
    signerEvmAddress: string;
    typedData: Record<string, unknown>;
    clearSigningManifest: Record<string, unknown>;
    expiresAt: string;
  },
): Promise<ApprovalRequest> {
  const id = makeId("approval");
  await run(
    db,
    `insert into approval_requests (
      id, award_id, action_type, signer_account_id, signer_evm_address, status, typed_data, clear_signing_manifest, expires_at
    ) values (?,?,?,?,?,'pending',?,?,?)`,
    [
      id,
      params.awardId,
      params.actionType,
      params.signerAccountId,
      params.signerEvmAddress,
      JSON.stringify(params.typedData),
      JSON.stringify(params.clearSigningManifest),
      params.expiresAt,
    ],
  );
  const row = await first(db, "select * from approval_requests where id = ?", [id]);
  return mapApproval(row!);
}

export async function getApprovalRequestByAwardId(db: D1Database, awardId: string): Promise<ApprovalRequest | null> {
  const row = await first(db, "select * from approval_requests where award_id = ?", [awardId]);
  return row ? mapApproval(row) : null;
}

export async function markApprovalApproved(
  db: D1Database,
  params: {
    awardId: string;
    signature: string;
    status: ApprovalRequest["status"];
  },
): Promise<void> {
  const now = nowIso();
  await run(
    db,
    `update approval_requests
     set signature = ?, status = ?, approved_at = ?, executed_at = case when ? = 'executed' then ? else executed_at end
     where award_id = ?`,
    [params.signature, params.status, now, params.status, now, params.awardId],
  );
}

/* -------------------------------------------------------------------------- */
/* prize claims                                                                */
/* -------------------------------------------------------------------------- */

export async function upsertPrizeClaim(
  db: D1Database,
  params: {
    awardId: string;
    claimantAccountId: string;
    claimantEvmAddress: string;
    tokenAddress?: string | null;
    serialNumber?: string | null;
    metadataURI?: string | null;
    status: PrizeClaim["status"];
    mintedTxHash?: string | null;
    redeemedTxHash?: string | null;
  },
): Promise<void> {
  await run(
    db,
    `insert into prize_claims (
      id, award_id, claimant_account_id, claimant_evm_address, token_address, serial_number, metadata_uri, status, minted_tx_hash, redeemed_tx_hash
    ) values (?,?,?,?,?,?,?,?,?,?)
    on conflict (award_id) do update set
      claimant_account_id = excluded.claimant_account_id,
      claimant_evm_address = excluded.claimant_evm_address,
      token_address = excluded.token_address,
      serial_number = excluded.serial_number,
      metadata_uri = excluded.metadata_uri,
      status = excluded.status,
      minted_tx_hash = coalesce(excluded.minted_tx_hash, prize_claims.minted_tx_hash),
      redeemed_tx_hash = coalesce(excluded.redeemed_tx_hash, prize_claims.redeemed_tx_hash),
      updated_at = ?`,
    [
      params.awardId,
      params.awardId,
      params.claimantAccountId,
      params.claimantEvmAddress,
      params.tokenAddress ?? null,
      params.serialNumber ?? null,
      params.metadataURI ?? null,
      params.status,
      params.mintedTxHash ?? null,
      params.redeemedTxHash ?? null,
      nowIso(),
    ],
  );
}

export async function getPrizeClaim(db: D1Database, id: string): Promise<PrizeClaim | null> {
  const row = await first(db, "select * from prize_claims where id = ?", [id]);
  return mapClaim(row);
}

export async function listPrizeClaims(db: D1Database, hackathonId?: string): Promise<PrizeClaim[]> {
  const rows = hackathonId
    ? await all(
        db,
        `select pc.* from prize_claims pc
         join award_proposals ap on ap.id = pc.award_id
         where ap.hackathon_id = ?
         order by pc.created_at desc`,
        [hackathonId],
      )
    : await all(db, "select * from prize_claims order by created_at desc");
  return rows.map((row) => mapClaim(row)!);
}

/* -------------------------------------------------------------------------- */
/* events + HCS audit                                                          */
/* -------------------------------------------------------------------------- */

export async function recordEvent(db: D1Database, input: Omit<EventEnvelope, "id" | "createdAt">): Promise<void> {
  await run(
    db,
    `insert into events (id, scope, source, type, actor, hackathon_id, submission_id, award_id, claim_id, tx_hash, payload)
     values (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      makeId("event"),
      input.scope,
      input.source,
      input.type,
      input.actor ?? null,
      input.hackathonId ?? null,
      input.submissionId ?? null,
      input.awardId ?? null,
      input.claimId ?? null,
      input.txHash ?? null,
      JSON.stringify(input.payload),
    ],
  );
}

export async function recordHcsAudit(
  db: D1Database,
  input: {
    type: string;
    hackathonId?: string | null;
    submissionId?: string | null;
    awardId?: string | null;
    txId: string | null;
    topicId: string | null;
    sequenceNumber: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await run(
    db,
    `insert into hcs_audit_events (id, type, hackathon_id, submission_id, award_id, tx_id, topic_id, sequence_number, payload)
     values (?,?,?,?,?,?,?,?,?)`,
    [
      makeId("hcs"),
      input.type,
      input.hackathonId ?? null,
      input.submissionId ?? null,
      input.awardId ?? null,
      input.txId,
      input.topicId,
      input.sequenceNumber,
      JSON.stringify(input.payload),
    ],
  );
}

export async function listEvents(
  db: D1Database,
  filters: {
    hackathonId?: string | null;
    submissionId?: string | null;
    scope?: EventEnvelope["scope"] | null;
  },
): Promise<EventEnvelope[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.hackathonId) {
    clauses.push("hackathon_id = ?");
    params.push(filters.hackathonId);
  }
  if (filters.submissionId) {
    clauses.push("submission_id = ?");
    params.push(filters.submissionId);
  }
  if (filters.scope) {
    clauses.push("scope = ?");
    params.push(filters.scope);
  }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const rows = await all(db, `select * from events ${where} order by created_at desc limit 250`, params);
  const events: EventEnvelope[] = rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    source: row.source,
    type: row.type,
    actor: row.actor ?? null,
    hackathonId: row.hackathon_id ?? null,
    submissionId: row.submission_id ?? null,
    awardId: row.award_id ?? null,
    claimId: row.claim_id ?? null,
    txHash: row.tx_hash ?? null,
    hcsTxId: null,
    hcsTopicId: null,
    hcsSequenceNumber: null,
    payload: parseJson<Record<string, any>>(row.payload, {}),
    createdAt: new Date(row.created_at).toISOString(),
  }));

  const auditTypes = Array.from(
    new Set(events.map((event) => mapEventAuditType(event.type)).filter((value): value is string => Boolean(value))),
  );
  if (auditTypes.length === 0) return events;

  // `type = any($1::text[])` becomes a generated `in (?,?,...)` list.
  const typeScope = inClause("type", auditTypes);
  const auditClauses: string[] = [typeScope.sql];
  const auditParams: unknown[] = [...typeScope.params];

  if (filters.hackathonId) {
    auditClauses.push("hackathon_id = ?");
    auditParams.push(filters.hackathonId);
  }
  if (filters.submissionId) {
    auditClauses.push("submission_id = ?");
    auditParams.push(filters.submissionId);
  }

  const auditWhere = auditClauses.length ? `where ${auditClauses.join(" and ")}` : "";
  const auditRows = await all(
    db,
    `select * from hcs_audit_events ${auditWhere} order by created_at desc limit 250`,
    auditParams,
  );
  const auditsByKey = new Map<string, Row>();

  for (const row of auditRows) {
    const key = makeAuditLookupKey({
      type: row.type,
      hackathonId: row.hackathon_id ?? null,
      submissionId: row.submission_id ?? null,
      awardId: row.award_id ?? null,
    });
    if (!auditsByKey.has(key)) {
      auditsByKey.set(key, row);
    }
  }

  return events.map((event) => {
    const auditType = mapEventAuditType(event.type);
    if (!auditType) return event;

    const audit = auditsByKey.get(
      makeAuditLookupKey({
        type: auditType,
        hackathonId: event.hackathonId,
        submissionId: event.submissionId,
        awardId: event.awardId,
      }),
    );

    if (!audit) return event;

    return {
      ...event,
      hcsTxId: audit.tx_id ?? null,
      hcsTopicId: normalizeAuditTopicId(audit.topic_id),
      hcsSequenceNumber: audit.sequence_number ?? null,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* jobs                                                                        */
/* -------------------------------------------------------------------------- */

export async function enqueueJob(db: D1Database, type: string, payload: Record<string, unknown>): Promise<string> {
  const id = makeId("job");
  await run(db, "insert into jobs (id, type, status, payload) values (?,?,'queued',?)", [
    id,
    type,
    JSON.stringify(payload),
  ]);
  return id;
}

/**
 * SQLite has no `for update skip locked`. Under D1's single-writer model a single conditional
 * `update ... where id = (select ... limit 1) and status = 'queued' returning *` is atomic:
 * two concurrent workers cannot both observe the row as queued.
 */
export async function claimNextJob(
  db: D1Database,
  workerId: string,
): Promise<{ id: string; type: string; payload: Record<string, unknown> } | null> {
  const now = nowIso();
  const leaseExpiresAt = isoPlusMs(JOB_LEASE_MS);
  const rows = await all(
    db,
    `update jobs
     set status = 'running', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
     where id = (
       select id from jobs where status = 'queued' and run_after <= ? order by created_at limit 1
     ) and status = 'queued'
     returning *`,
    [workerId, leaseExpiresAt, now, now],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, type: row.type, payload: parseJson<Record<string, unknown>>(row.payload, {}) };
}

export async function completeJob(db: D1Database, id: string): Promise<void> {
  await run(
    db,
    "update jobs set status = 'completed', lease_owner = null, lease_expires_at = null, updated_at = ? where id = ?",
    [nowIso(), id],
  );
}

/**
 * Retry-aware failure handling: while `attempts` is below `JOB_MAX_ATTEMPTS` the job goes back
 * to 'queued' with an `attempts * 30s` backoff; it only becomes 'failed' on the third attempt.
 * The backoff timestamps are precomputed in JS and selected by a `case` on `attempts`, so the
 * whole decision stays in one atomic statement without any SQLite date arithmetic.
 */
export async function failJob(db: D1Database, id: string, error: string): Promise<void> {
  const startedAt = Date.now();
  const now = isoPlusMs(0, startedAt);
  await run(
    db,
    `update jobs set
       status = case when attempts < ${JOB_MAX_ATTEMPTS} then 'queued' else 'failed' end,
       last_error = ?,
       lease_owner = null,
       lease_expires_at = null,
       run_after = case
         when attempts >= ${JOB_MAX_ATTEMPTS} then run_after
         when attempts = 2 then ?
         when attempts = 1 then ?
         else ?
       end,
       updated_at = ?
     where id = ?`,
    [
      error,
      isoPlusMs(2 * JOB_RETRY_BACKOFF_MS, startedAt),
      isoPlusMs(1 * JOB_RETRY_BACKOFF_MS, startedAt),
      now,
      now,
      id,
    ],
  );
}

/**
 * Not present in the Postgres original: a job whose worker died mid-flight kept its 'running'
 * status forever. On Workers that is a matter of when, not if, so expired leases are recycled.
 * Returns the number of jobs requeued.
 */
export async function reapExpiredLeases(db: D1Database): Promise<number> {
  const now = nowIso();
  const rows = await all(
    db,
    `update jobs
     set status = 'queued', lease_owner = null, lease_expires_at = null, run_after = ?, updated_at = ?
     where status = 'running' and lease_expires_at is not null and lease_expires_at < ?
     returning id`,
    [now, now, now],
  );
  return rows.length;
}

/**
 * The Postgres version returned pg's `QueryResultRow`. `pg` is not available in Workers, so the
 * equivalent structural type is used; `payload` is decoded so the shape matches the original.
 */
export async function getJobState(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  const row = await first(db, "select * from jobs where id = ?", [id]);
  if (!row) return null;
  return { ...row, payload: parseJson<Record<string, unknown>>(row.payload, {}) };
}

export async function listJobs(
  db: D1Database,
): Promise<
  Array<{ id: string; type: string; status: string; payload: Record<string, unknown>; lastError: string | null; createdAt: string }>
> {
  const rows = await all(db, "select * from jobs order by created_at desc limit 250");
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    lastError: row.last_error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/* -------------------------------------------------------------------------- */
/* similarity clusters                                                         */
/* -------------------------------------------------------------------------- */

export type StoredCluster = {
  id: string;
  label: string;
  theme: string;
  agentRationale: string;
  agentId: string;
  method: string;
  model: string;
  keywords: string[];
  cohesion: number | null;
  submissionIds: string[];
  clusteredAt: string;
};

export async function listSimilarityClusters(db: D1Database, hackathonId: string): Promise<StoredCluster[]> {
  const rows = await all(db, "select * from similarity_clusters where hackathon_id = ? order by created_at asc", [
    hackathonId,
  ]);
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    theme: row.theme,
    agentRationale: row.agent_rationale,
    agentId: row.agent_id,
    method: row.method,
    model: row.model,
    keywords: parseJson<string[]>(row.keywords, []),
    cohesion: row.cohesion === null || row.cohesion === undefined ? null : Number(row.cohesion),
    submissionIds: parseJson<string[]>(row.submission_ids, []),
    clusteredAt: row.clustered_at,
  }));
}

/** Replaces a hackathon's clustering atomically, so a read never sees a half-written set. */
export async function replaceSimilarityClusters(
  db: D1Database,
  hackathonId: string,
  clusters: StoredCluster[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    statement(db, "delete from similarity_clusters where hackathon_id = ?", [hackathonId]),
  ];
  for (const cluster of clusters) {
    statements.push(
      statement(
        db,
        `insert into similarity_clusters (
           id, hackathon_id, label, theme, agent_rationale, agent_id, method, model,
           keywords, cohesion, submission_ids, clustered_at
         ) values (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          cluster.id,
          hackathonId,
          cluster.label,
          cluster.theme,
          cluster.agentRationale,
          cluster.agentId,
          cluster.method,
          cluster.model,
          JSON.stringify(cluster.keywords),
          cluster.cohesion,
          JSON.stringify(cluster.submissionIds),
          cluster.clusteredAt,
        ],
      ),
    );
  }
  await db.batch(statements);
}
