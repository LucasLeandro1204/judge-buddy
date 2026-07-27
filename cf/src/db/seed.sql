-- Demo program for the public deployment.
--
-- The survey of the old app found that every screen renders empty when the database is empty,
-- with no fallback, so a fresh deployment looked broken. This seeds one program with three
-- tracks and four submissions.
--
-- The submissions point at REAL public repositories and REAL live URLs. That is deliberate: the
-- eligibility agent actually calls the GitHub API and actually requests the demo URL, so the
-- evidence it records is genuine rather than staged. Team names are labelled as demo entries and
-- no scores are pre-seeded — every score visible in the deployed app was produced by the
-- pipeline at runtime.
--
-- Idempotent: re-running replaces the demo rows and leaves real programs untouched.

-- Order matters: children before parents, and the seeded jobs must go too or their fixed ids
-- collide with the PRIMARY KEY on a re-run.
DELETE FROM jobs        WHERE id LIKE 'job-seed-%';
DELETE FROM events      WHERE hackathon_id = 'hackathon-demo-hedera';
DELETE FROM submissions WHERE hackathon_id = 'hackathon-demo-hedera';
DELETE FROM tracks      WHERE hackathon_id = 'hackathon-demo-hedera';
DELETE FROM hackathons  WHERE id = 'hackathon-demo-hedera';

INSERT INTO hackathons (
  id, name, tagline,
  organizer_account_id, organizer_evm_address,
  judge_account_id, judge_evm_address,
  payout_token_id, payout_token_evm_address,
  autonomous_threshold, approval_expiry_seconds,
  starts_at, ends_at, submission_deadline, judging_ends_at
) VALUES (
  'hackathon-demo-hedera',
  'Hedera Builders Round (Demo)',
  'A worked example of evidence-backed judging and contract-enforced payout.',
  -- Organizer and judge are the deployed relayer account, so the treasury bootstrap and the
  -- judge-approval path both have a real signer on testnet.
  '0.0.9797514', '0x96652BF6f1E04Bb26483A4B641CF49966FD74D5d',
  '0.0.9797514', '0x96652BF6f1E04Bb26483A4B641CF49966FD74D5d',
  'jbUSD', '0x398cAFe2C8d16BdF6c970D3e251A899A481a0D4D',
  -- 500.000000 in 6-decimal base units. Awards at or below this settle autonomously;
  -- anything above needs a judge signature.
  '500000000', 86400,
  '2026-07-01T09:00:00.000Z',
  '2026-08-30T18:00:00.000Z',
  '2026-08-28T23:59:00.000Z',
  '2026-08-30T18:00:00.000Z'
);

-- Track prize below the ceiling -> autonomous settlement.
INSERT INTO tracks (id, hackathon_id, name, description, sponsor_name, prize_amount, requirements, evaluation_policy)
VALUES (
  'track-demo-tooling', 'hackathon-demo-hedera',
  'Developer Tooling',
  'SDKs, libraries and developer surfaces that make building on Hedera faster.',
  'Demo Sponsor',
  '250000000',
  '["Public GitHub repository","README documenting setup","Reachable demo or published package"]',
  '{"requiresPublicRepo":true,"requiresReadme":true,"requiresDemo":true,"requiresContracts":false,"requiresHashscanVerification":false,"minQualityScore":40,"weights":{"technicalExecution":35,"innovation":25,"documentation":20,"realWorldImpact":20}}'
);

-- Track prize above the ceiling -> requires a signed judge approval.
INSERT INTO tracks (id, hackathon_id, name, description, sponsor_name, prize_amount, requirements, evaluation_policy)
VALUES (
  'track-demo-defi', 'hackathon-demo-hedera',
  'Applications',
  'End-user applications and protocols with a working, demonstrable flow.',
  'Demo Sponsor',
  '2500000000',
  '["Public GitHub repository","Working demo","Documented architecture"]',
  '{"requiresPublicRepo":true,"requiresReadme":true,"requiresDemo":true,"requiresContracts":false,"requiresHashscanVerification":false,"minQualityScore":45,"weights":{"technicalExecution":30,"innovation":30,"designAndUx":20,"realWorldImpact":20}}'
);

INSERT INTO tracks (id, hackathon_id, name, description, sponsor_name, prize_amount, requirements, evaluation_policy)
VALUES (
  'track-demo-infra', 'hackathon-demo-hedera',
  'Infrastructure',
  'Indexers, data services and network infrastructure.',
  'Demo Sponsor',
  '400000000',
  '["Public GitHub repository","Documentation","At least one usage example"]',
  '{"requiresPublicRepo":true,"requiresReadme":true,"requiresDemo":true,"requiresContracts":false,"requiresHashscanVerification":false,"minQualityScore":40,"weights":{"technicalExecution":40,"documentation":30,"realWorldImpact":30}}'
);

-- Submissions. Real repositories and real URLs, so the agents' checks return real results.
INSERT INTO submissions (
  id, hackathon_id, track_id, project_name, team_name, team_members,
  github_url, demo_url, description,
  payout_account_id, payout_evm_address, deployed_contracts, status
) VALUES
(
  'submission-demo-sdk', 'hackathon-demo-hedera', 'track-demo-tooling',
  'Hedera SDK for JavaScript', 'Demo entry - upstream project',
  '["Demo entry"]',
  'https://github.com/hiero-ledger/hiero-sdk-js',
  'https://docs.hedera.com/hedera/sdks-and-apis/sdks',
  'The official JavaScript SDK for the Hedera network, covering accounts, tokens, consensus topics and smart contracts. Included as a demo submission so the eligibility agent runs against a substantial real repository.',
  '0.0.9797514', '0x96652BF6f1E04Bb26483A4B641CF49966FD74D5d', '[]', 'pending'
),
(
  'submission-demo-mirror', 'hackathon-demo-hedera', 'track-demo-infra',
  'Hedera Mirror Node', 'Demo entry - upstream project',
  '["Demo entry"]',
  'https://github.com/hiero-ledger/hiero-mirror-node',
  'https://testnet.mirrornode.hedera.com/api/v1/network/nodes',
  'Mirror node implementation providing REST and gRPC access to Hedera network state and history. The demo URL is a live API endpoint, so the reachability check exercises a real service.',
  '0.0.9797514', '0x96652BF6f1E04Bb26483A4B641CF49966FD74D5d', '[]', 'pending'
),
(
  'submission-demo-wallet', 'hackathon-demo-hedera', 'track-demo-defi',
  'Hedera Wallet Connect', 'Demo entry - upstream project',
  '["Demo entry"]',
  'https://github.com/hashgraph/hedera-wallet-connect',
  'https://portal.hedera.com/',
  'WalletConnect integration for Hedera, letting dApps request signatures and transactions from user wallets. Sits in the Applications track, whose prize is above the autonomy ceiling, so any award here requires a signed judge approval.',
  '0.0.9797514', '0x96652BF6f1E04Bb26483A4B641CF49966FD74D5d', '[]', 'pending'
),
(
  'submission-demo-broken', 'hackathon-demo-hedera', 'track-demo-tooling',
  'Unreachable Demo (Deliberate Failure)', 'Demo entry - negative case',
  '["Demo entry"]',
  'https://github.com/hiero-ledger/hiero-sdk-js',
  'https://this-domain-does-not-resolve-judgebuddy-demo.invalid/',
  'Included on purpose so the eligibility agent has something to reject. The repository is real but the demo URL does not resolve, which fails this track''s requiresDemo rule. The rejection notes state exactly which check failed.',
  '0.0.9797514', '0x96652BF6f1E04Bb26483A4B641CF49966FD74D5d', '[]', 'pending'
);

-- Queue the pipeline for each seeded submission. The cron handler picks these up within a minute.
INSERT INTO jobs (id, type, status, payload) VALUES
  ('job-seed-sdk',    'evaluate_submission', 'queued', '{"submissionId":"submission-demo-sdk"}'),
  ('job-seed-mirror', 'evaluate_submission', 'queued', '{"submissionId":"submission-demo-mirror"}'),
  ('job-seed-wallet', 'evaluate_submission', 'queued', '{"submissionId":"submission-demo-wallet"}'),
  ('job-seed-broken', 'evaluate_submission', 'queued', '{"submissionId":"submission-demo-broken"}');
