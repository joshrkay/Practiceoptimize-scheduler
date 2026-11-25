-- RAH-14: per-practice background job queue used by apps/worker.
-- Objects are not schema-qualified so the migration applies to whatever schema is first on search_path.
-- Job type and idempotency key are PHI-free machine identifiers (enforced by the worker); payload carries
-- record IDs, and errors are stored as codes only.

CREATE TABLE jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint      GENERATED ALWAYS AS IDENTITY,
  practice_id      uuid        NOT NULL,
  type             text        NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length(type) <= 100),
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload          jsonb       NOT NULL DEFAULT 'null'::jsonb,
  checkpoint       jsonb,
  status           text        NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer     NOT NULL CHECK (max_attempts >= 1),
  run_at           timestamptz NOT NULL,
  lease_token      uuid,
  lease_expires_at timestamptz,
  result           jsonb,
  last_error       text        CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_]{1,64}$'),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  CONSTRAINT jobs_practice_idempotency_key UNIQUE (practice_id, idempotency_key),
  CONSTRAINT jobs_lease_matches_status CHECK ((status = 'running') = (lease_token IS NOT NULL))
);

-- Claim path: ready jobs per practice, oldest first.
CREATE INDEX jobs_ready_idx ON jobs (practice_id, run_at, seq) WHERE status = 'queued';
-- Per-practice running counts and expired-lease sweeps.
CREATE INDEX jobs_running_idx ON jobs (practice_id, lease_expires_at) WHERE status = 'running';
-- Dead-letter review per practice.
CREATE INDEX jobs_practice_status_idx ON jobs (practice_id, status);

-- Practice isolation for application roles. The worker connects as the table owner, which claims across
-- practices; every other role sees only the practice set in app.current_practice_id.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_practice_isolation ON jobs
  USING (practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid)
  WITH CHECK (practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid);
