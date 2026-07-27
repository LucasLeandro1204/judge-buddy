-- JudgeBuddy persistence schema, SQLite / Cloudflare D1 port of server/src/db.ts ensureSchema().
--
-- Conversion rules applied:
--   numeric(78,0)  -> TEXT  (uint256 base units; must stay exact decimal strings, never JS numbers)
--   timestamptz    -> TEXT  (ISO-8601 UTC, e.g. 2026-07-27T12:34:56.789Z; lexicographically sortable)
--   jsonb          -> TEXT  (JSON document; JSON.stringify on write, JSON.parse on read)
--   default now()  -> DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
--
-- Every statement is idempotent so this file can be replayed against an existing database.

create table if not exists hackathons (
  id text primary key,
  name text not null,
  tagline text not null,
  organizer_account_id text not null,
  organizer_evm_address text not null,
  judge_account_id text not null,
  judge_evm_address text not null,
  payout_token_id text not null,
  payout_token_evm_address text not null,
  autonomous_threshold text not null,
  approval_expiry_seconds integer not null,
  starts_at text not null,
  ends_at text not null,
  submission_deadline text not null,
  judging_ends_at text not null,
  treasury_tx_hash text,
  treasury_contract_address text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists hackathons_created_at_idx on hackathons (created_at desc);

create table if not exists sponsors (
  id text primary key,
  hackathon_id text not null references hackathons(id) on delete cascade,
  name text not null,
  account_id text,
  evm_address text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists sponsors_hackathon_id_idx on sponsors (hackathon_id, created_at);

create table if not exists tracks (
  id text primary key,
  hackathon_id text not null references hackathons(id) on delete cascade,
  name text not null,
  description text not null,
  sponsor_name text not null,
  prize_amount text not null,
  requirements text not null,
  evaluation_policy text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists tracks_hackathon_id_idx on tracks (hackathon_id, created_at);

create table if not exists sponsor_deposits (
  id text primary key,
  hackathon_id text not null references hackathons(id) on delete cascade,
  track_id text not null references tracks(id) on delete cascade,
  sponsor_account_id text,
  sponsor_evm_address text,
  token_id text not null,
  amount text not null,
  tx_hash text not null,
  status text not null,
  metadata text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists sponsor_deposits_hackathon_id_idx on sponsor_deposits (hackathon_id, created_at);
create index if not exists sponsor_deposits_track_id_idx on sponsor_deposits (track_id);

create table if not exists submissions (
  id text primary key,
  hackathon_id text not null references hackathons(id) on delete cascade,
  track_id text not null references tracks(id) on delete cascade,
  project_name text not null,
  team_name text not null,
  team_members text not null,
  github_url text not null,
  demo_url text not null,
  description text not null,
  payout_account_id text not null,
  payout_evm_address text not null,
  deployed_contracts text not null default '[]',
  status text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists submissions_hackathon_id_idx on submissions (hackathon_id, created_at desc);
create index if not exists submissions_track_id_idx on submissions (track_id);

create table if not exists evaluation_runs (
  id text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  agent_role text not null,
  status text not null,
  result text,
  model text,
  error text,
  started_at text,
  completed_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists evaluation_runs_submission_id_idx on evaluation_runs (submission_id, created_at);
create index if not exists evaluation_runs_submission_role_idx on evaluation_runs (submission_id, agent_role);

create table if not exists award_proposals (
  id text primary key,
  hackathon_id text not null references hackathons(id) on delete cascade,
  submission_id text not null references submissions(id) on delete cascade,
  track_id text not null references tracks(id) on delete cascade,
  winner_account_id text not null,
  winner_evm_address text not null,
  amount text not null,
  settlement_mode text not null,
  status text not null,
  reason text not null,
  machine_policy text not null default '{}',
  digest text,
  tx_hash text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists award_proposals_submission_id_idx on award_proposals (submission_id, created_at desc);
create index if not exists award_proposals_hackathon_id_idx on award_proposals (hackathon_id, created_at desc);
create index if not exists award_proposals_track_id_idx on award_proposals (track_id);

create table if not exists approval_requests (
  id text primary key,
  award_id text not null unique references award_proposals(id) on delete cascade,
  action_type text not null,
  signer_account_id text not null,
  signer_evm_address text not null,
  status text not null,
  typed_data text not null,
  clear_signing_manifest text not null,
  signature text,
  expires_at text not null,
  approved_at text,
  executed_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Required by the `on conflict (award_id) do update` upsert path and by lookups by award.
create unique index if not exists approval_requests_award_id_key on approval_requests (award_id);
create index if not exists approval_requests_created_at_idx on approval_requests (created_at desc);

create table if not exists prize_claims (
  id text primary key,
  award_id text not null unique references award_proposals(id) on delete cascade,
  claimant_account_id text not null,
  claimant_evm_address text not null,
  token_address text,
  serial_number text,
  metadata_uri text,
  status text not null,
  minted_tx_hash text,
  redeemed_tx_hash text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Required by upsertPrizeClaim's `on conflict (award_id) do update`.
create unique index if not exists prize_claims_award_id_key on prize_claims (award_id);
create index if not exists prize_claims_created_at_idx on prize_claims (created_at desc);

create table if not exists events (
  id text primary key,
  scope text not null,
  source text not null,
  type text not null,
  actor text,
  hackathon_id text,
  submission_id text,
  award_id text,
  claim_id text,
  tx_hash text,
  payload text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists events_created_at_idx on events (created_at desc);
create index if not exists events_hackathon_id_idx on events (hackathon_id, created_at desc);
create index if not exists events_submission_id_idx on events (submission_id, created_at desc);
create index if not exists events_scope_idx on events (scope, created_at desc);

create table if not exists hcs_audit_events (
  id text primary key,
  type text not null,
  hackathon_id text,
  submission_id text,
  award_id text,
  tx_id text,
  topic_id text,
  sequence_number text,
  payload text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists hcs_audit_events_type_idx on hcs_audit_events (type, created_at desc);
create index if not exists hcs_audit_events_hackathon_id_idx on hcs_audit_events (hackathon_id, created_at desc);
create index if not exists hcs_audit_events_submission_id_idx on hcs_audit_events (submission_id, created_at desc);
create index if not exists hcs_audit_events_award_id_idx on hcs_audit_events (award_id);

create table if not exists jobs (
  id text primary key,
  type text not null,
  status text not null,
  payload text not null,
  attempts integer not null default 0,
  lease_owner text,
  lease_expires_at text,
  last_error text,
  run_after text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- claimNextJob: where status = 'queued' and run_after <= ? order by created_at limit 1
create index if not exists jobs_status_run_after_idx on jobs (status, run_after);
-- reapExpiredLeases: where status = 'running' and lease_expires_at < ?
create index if not exists jobs_status_lease_expires_at_idx on jobs (status, lease_expires_at);
-- listJobs: order by created_at desc limit 250
create index if not exists jobs_created_at_idx on jobs (created_at desc);

-- ---------------------------------------------------------------------------
-- auth_used_nonces
--
-- Sign-in challenges are HMAC-signed rather than stored (see cf/src/lib/session.ts), which
-- makes them verifiable without server state but not single-use. Recording each redeemed
-- nonce closes that gap: a captured challenge cannot be replayed inside its validity window.
-- Rows are pruned by the cron handler once past expiry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_used_nonces (
  nonce      TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_used_nonces_expires_at ON auth_used_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- similarity_clusters
--
-- Converge output, persisted. The first version computed clustering inside
-- GET /hackathons/:id, which put a Workers AI call on a read path: every page view cost
-- 8-9 seconds and a model invocation, against 0.35s for the same query without it.
-- Clustering is now a pipeline job and the read path just selects these rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS similarity_clusters (
  id             TEXT PRIMARY KEY,
  hackathon_id   TEXT NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  theme          TEXT NOT NULL,
  agent_rationale TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  method         TEXT NOT NULL,
  model          TEXT NOT NULL,
  keywords       TEXT NOT NULL DEFAULT '[]',
  cohesion       REAL,
  submission_ids TEXT NOT NULL DEFAULT '[]',
  clustered_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_similarity_clusters_hackathon ON similarity_clusters (hackathon_id);
