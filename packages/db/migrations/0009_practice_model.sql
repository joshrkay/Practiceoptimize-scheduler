-- RAH-9: organizations, practices, locations, facilities, surgeons.
--
-- The practice is the isolation boundary. Every practice-owned row carries practice_id.
-- Facilities are global and shared by many practices; each practice's own settings for a facility live in
-- practice_facility_settings. Row-level security is added by a later migration (RAH-10), not here.
--
-- Join tables carry practice_id and use composite foreign keys (practice_id, id) so a row can never link
-- records from two different practices.

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE practices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid REFERENCES organizations (id),
  name                 text NOT NULL CHECK (length(trim(name)) > 0),
  is_covered_entity    boolean NOT NULL DEFAULT true,
  baa_status           text NOT NULL DEFAULT 'not_started'
                         CHECK (baa_status IN ('not_started', 'sent', 'signed', 'terminated')),
  baa_signed_on        date,
  availity_customer_id text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (baa_status <> 'signed' OR baa_signed_on IS NOT NULL)
);
CREATE INDEX practices_organization_id_idx ON practices (organization_id);

CREATE TABLE locations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id         uuid NOT NULL REFERENCES practices (id),
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  address_line1       text NOT NULL,
  address_line2       text,
  city                text NOT NULL,
  state               char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  postal_code         text NOT NULL CHECK (postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  time_zone           text NOT NULL,
  billing_npi         char(10) NOT NULL CHECK (billing_npi ~ '^[0-9]{10}$'),
  billing_tin         char(9) NOT NULL CHECK (billing_tin ~ '^[0-9]{9}$'),
  phone_number        text NOT NULL,
  sms_number          text,
  hours               jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ehr_instance text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, id)
);

CREATE TABLE facilities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  facility_type text NOT NULL CHECK (facility_type IN ('asc', 'office_procedure_room')),
  npi           char(10) CHECK (npi ~ '^[0-9]{10}$'),
  address_line1 text NOT NULL,
  address_line2 text,
  city          text NOT NULL,
  state         char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  postal_code   text NOT NULL CHECK (postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  time_zone     text NOT NULL,
  phone_number  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (npi)
);

CREATE TABLE practice_facility_settings (
  practice_id     uuid NOT NULL REFERENCES practices (id),
  facility_id     uuid NOT NULL REFERENCES facilities (id),
  or_desk_contacts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(or_desk_contacts) = 'array'),
  posting_method  text NOT NULL CHECK (posting_method IN ('portal', 'fax', 'email', 'phone')),
  block_schedules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(block_schedules) = 'array'),
  rules           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rules) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, facility_id)
);
CREATE INDEX practice_facility_settings_facility_id_idx ON practice_facility_settings (facility_id);

CREATE TABLE surgeons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid NOT NULL REFERENCES practices (id),
  npi         char(10) NOT NULL CHECK (npi ~ '^[0-9]{10}$'),
  first_name  text NOT NULL,
  last_name   text NOT NULL,
  specialty   text NOT NULL DEFAULT 'podiatry',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, id),
  UNIQUE (practice_id, npi)
);

CREATE TABLE surgeon_locations (
  practice_id uuid NOT NULL,
  surgeon_id  uuid NOT NULL,
  location_id uuid NOT NULL,
  PRIMARY KEY (surgeon_id, location_id),
  FOREIGN KEY (practice_id, surgeon_id) REFERENCES surgeons (practice_id, id) ON DELETE CASCADE,
  FOREIGN KEY (practice_id, location_id) REFERENCES locations (practice_id, id) ON DELETE CASCADE
);
CREATE INDEX surgeon_locations_practice_id_idx ON surgeon_locations (practice_id);

-- A surgeon can hold privileges only at a facility their practice operates at.
CREATE TABLE surgeon_facility_privileges (
  practice_id uuid NOT NULL,
  surgeon_id  uuid NOT NULL,
  facility_id uuid NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'expired')),
  expires_on  date,
  PRIMARY KEY (surgeon_id, facility_id),
  FOREIGN KEY (practice_id, surgeon_id) REFERENCES surgeons (practice_id, id) ON DELETE CASCADE,
  FOREIGN KEY (practice_id, facility_id)
    REFERENCES practice_facility_settings (practice_id, facility_id) ON DELETE CASCADE
);
CREATE INDEX surgeon_facility_privileges_practice_id_idx ON surgeon_facility_privileges (practice_id);
