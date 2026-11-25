-- RAH-36: care team coordination requests.
-- One row per request the agent sends to a care team party for a case. Status lifecycle:
-- open -> answered | overdue | cancelled; overdue -> answered | cancelled.
-- Requests are idempotent per practice, case, party and type: at most one active (open or overdue) row.

CREATE TABLE coordination_requests (
  id               text        PRIMARY KEY,
  practice_id      uuid        NOT NULL,
  case_id          text        NOT NULL,
  party_id         text        NOT NULL,
  party_role       text        NOT NULL CHECK (party_role IN (
                     'facility_or_desk', 'vendor_rep', 'primary_care', 'cardiology',
                     'anesthesia', 'surgeon', 'post_op_service')),
  request_type     text        NOT NULL CHECK (request_type IN (
                     'clearance', 'pre_op_test', 'facility_posting', 'anesthesia_packet',
                     'vendor_rep', 'peer_to_peer', 'post_op_service')),
  step_id          text        NOT NULL,
  stage            text        NOT NULL,
  channel          text        NOT NULL CHECK (channel IN ('fax', 'email', 'in_basket')),
  status           text        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open', 'answered', 'overdue', 'cancelled')),
  approval_status  text        NOT NULL CHECK (approval_status IN ('not_required', 'pending', 'approved')),
  approval_via     text        CHECK (approval_via IN ('review_queue', 'change_plan')),
  approval_ref     text,
  approved_at      timestamptz,
  surgery_date     date        NOT NULL,
  due_at           timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  answered_at      timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  reminders_sent   smallint    NOT NULL DEFAULT 0 CHECK (reminders_sent BETWEEN 0 AND 2),
  phone_task_id    text,
  supersedes_id    text        REFERENCES coordination_requests (id),
  blocks_readiness boolean     NOT NULL,
  history          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Facility postings and peer-to-peers are approve-first: they are never sent without an approval.
  CONSTRAINT coordination_requests_approve_first CHECK (
    request_type NOT IN ('facility_posting', 'peer_to_peer') OR approval_status <> 'not_required'),
  CONSTRAINT coordination_requests_unsent_until_approved CHECK (
    approval_status <> 'pending' OR sent_at IS NULL),
  CONSTRAINT coordination_requests_answered_at CHECK ((status = 'answered') = (answered_at IS NOT NULL)),
  CONSTRAINT coordination_requests_cancelled_at CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE UNIQUE INDEX coordination_requests_one_active
  ON coordination_requests (practice_id, case_id, party_id, request_type)
  WHERE status IN ('open', 'overdue');

CREATE INDEX coordination_requests_by_case ON coordination_requests (practice_id, case_id);

CREATE INDEX coordination_requests_active_sweep ON coordination_requests (practice_id, sent_at)
  WHERE status IN ('open', 'overdue');

ALTER TABLE coordination_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE coordination_requests FORCE ROW LEVEL SECURITY;

-- No practice set in the session (unset or empty) means no rows.
CREATE POLICY coordination_requests_practice_isolation ON coordination_requests
  USING (practice_id = NULLIF(current_setting('app.practice_id', true), '')::uuid)
  WITH CHECK (practice_id = NULLIF(current_setting('app.practice_id', true), '')::uuid);
