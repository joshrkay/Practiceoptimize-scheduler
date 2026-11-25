-- RAH-8: immutable audit log. Append-only enforced by grants AND triggers.
-- Unqualified names: the migration runner (or a test) sets search_path.
-- Retention is 6 years (AUDIT_RETENTION_YEARS); nothing in this schema deletes rows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scheduler_app') THEN
    CREATE ROLE scheduler_app NOLOGIN;
  END IF;
END
$$;

CREATE TABLE audit_events (
  id                      uuid PRIMARY KEY,
  practice_id             text NOT NULL,
  location_id             text,
  actor_type              text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id                text NOT NULL,
  action                  text NOT NULL,
  target_type             text NOT NULL,
  target_id               text NOT NULL,
  inputs_hash             text NOT NULL CHECK (inputs_hash ~ '^[0-9a-f]{64}$'),
  result                  text NOT NULL CHECK (result IN ('success', 'failure', 'denied')),
  autonomy_tier           smallint NOT NULL CHECK (autonomy_tier >= 0),
  approver_id             text,
  external_transaction_id text,
  occurred_at             timestamptz NOT NULL
);

CREATE INDEX audit_events_practice_time_idx ON audit_events (practice_id, occurred_at);
CREATE INDEX audit_events_target_idx ON audit_events (practice_id, target_type, target_id);

CREATE FUNCTION audit_events_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();

REVOKE ALL ON audit_events FROM PUBLIC;
GRANT SELECT, INSERT ON audit_events TO scheduler_app;
