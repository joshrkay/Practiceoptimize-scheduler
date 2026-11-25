-- Care team directory (RAH-35).
-- practice_id is null for shared facility entries; practice-owned parties carry it.
-- No foreign key to a practices table: that table is owned by another issue and is added at integration.
-- Row-level security is deferred to the shared RLS migration; this file only adds the structure.

CREATE TABLE directory_parties (
  id                text PRIMARY KEY,
  practice_id       text,
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN
                      ('pcp','cardiology','vascular','lab','asc_scheduling','pre_admission_testing','vendor_rep')),
  role              text NOT NULL,
  preferred_channel text NOT NULL CHECK (preferred_channel IN ('fax','email','in_basket')),
  hours             jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX directory_parties_practice_idx ON directory_parties (practice_id);

CREATE TABLE directory_endpoints (
  party_id    text NOT NULL REFERENCES directory_parties (id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('fax','email','in_basket')),
  address     text NOT NULL CHECK (length(btrim(address)) > 0),
  verified_by text,
  verified_at timestamptz,
  PRIMARY KEY (party_id, channel),
  -- Verified means both who and when; otherwise neither.
  CONSTRAINT directory_endpoints_verification_pair CHECK ((verified_by IS NULL) = (verified_at IS NULL))
);
