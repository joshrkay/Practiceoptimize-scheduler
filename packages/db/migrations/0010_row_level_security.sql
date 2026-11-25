-- RAH-10: practice isolation with PostgreSQL row-level security.
--
-- The application connects as (or as a member of) scheduler_app, which is not a superuser and has no
-- BYPASSRLS. Each transaction sets the session variable app.practice_id from the authenticated session
-- (see packages/db/src/practice-context.ts). With no practice context, practice-owned tables return zero
-- rows.
--
-- Every table with a practice_id column gets the same policy through app_enable_practice_isolation().
-- A migration that adds a practice-owned table must call it:
--     SELECT app_enable_practice_isolation('my_new_table');
-- The cross-practice test suite (packages/db/tests/cross-practice.test.ts) fails for any practice_id table
-- that is missing the policy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scheduler_app') THEN
    CREATE ROLE scheduler_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
-- Re-assert in case the role existed with other attributes.
ALTER ROLE scheduler_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO scheduler_app', current_schema());
END
$$;

-- The current practice, or NULL when none is set. NULL never equals a practice_id, so no rows match.
CREATE FUNCTION app_current_practice_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.practice_id', true), '')::uuid $$;

-- Turns on forced row-level security for a practice-owned table and grants the application role DML on it.
CREATE FUNCTION app_enable_practice_isolation(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS practice_isolation ON %s', target);
  EXECUTE format(
    'CREATE POLICY practice_isolation ON %s
       USING (practice_id = app_current_practice_id())
       WITH CHECK (practice_id = app_current_practice_id())',
    target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO scheduler_app', target);
END
$$;
REVOKE ALL ON FUNCTION app_enable_practice_isolation(regclass) FROM PUBLIC;

DO $$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT format('%I.%I', c.table_schema, c.table_name)::regclass
    FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'practice_id'
      AND c.table_schema = current_schema()
      AND tb.table_type = 'BASE TABLE'
  LOOP
    PERFORM app_enable_practice_isolation(t);
  END LOOP;
END
$$;

-- practices: a session sees only its own practice. Not forced, so the owner (provisioning) can create
-- practices; the application role only reads.
ALTER TABLE practices ENABLE ROW LEVEL SECURITY;
CREATE POLICY practice_self ON practices USING (id = app_current_practice_id());
GRANT SELECT ON practices TO scheduler_app;

-- organizations: a session sees only the parent organization of its own practice.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY practice_parent ON organizations
  USING (id IN (SELECT organization_id FROM practices WHERE id = app_current_practice_id()));
GRANT SELECT ON organizations TO scheduler_app;

-- facilities are global and shared; practice-specific facility data lives in practice_facility_settings.
GRANT SELECT ON facilities TO scheduler_app;
