-- RAH-94: append-only, de-identified billable case events.
-- Rows hold no PHI (case_reference is an opaque id), so they survive the 90-day case PHI deletion.

CREATE TABLE billable_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  practice_id     text        NOT NULL CHECK (practice_id <> ''),
  location_id     text        NOT NULL CHECK (location_id <> ''),
  case_reference  text        NOT NULL CHECK (case_reference <> ''),
  series_id       text,
  urgent_add_on   boolean     NOT NULL DEFAULT false,
  booked_at       timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  -- A case is billed once per practice, however often it is rescheduled, cancelled or reopened.
  CONSTRAINT billable_events_one_per_case UNIQUE (practice_id, case_reference)
);

CREATE INDEX billable_events_practice_month_idx ON billable_events (practice_id, booked_at);

-- Append-only: reject UPDATE, DELETE and TRUNCATE for every role, including the owner.
CREATE FUNCTION billable_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'billable_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER billable_events_no_update_delete
  BEFORE UPDATE OR DELETE ON billable_events
  FOR EACH ROW EXECUTE FUNCTION billable_events_reject_change();

CREATE TRIGGER billable_events_no_truncate
  BEFORE TRUNCATE ON billable_events
  FOR EACH STATEMENT EXECUTE FUNCTION billable_events_reject_change();

-- Row-level security: the practice is the isolation boundary.
ALTER TABLE billable_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billable_events FORCE ROW LEVEL SECURITY;

CREATE POLICY billable_events_practice_isolation ON billable_events
  USING (practice_id = current_setting('app.practice_id', true))
  WITH CHECK (practice_id = current_setting('app.practice_id', true));
