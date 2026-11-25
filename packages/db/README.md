# @scheduler/db

Schema, migrations, row-level security policies.

## Migrations

Add a file to `migrations/` named `<4-digit issue number>_<name>.sql`. `runMigrations(client)` applies
pending files in filename order, each in its own transaction, and refuses to run if an applied file was
edited later.

## Practice isolation

- Every practice-owned table has a `practice_id` column. In the migration that creates it, call
  `SELECT app_enable_practice_isolation('<table>');` to turn on forced row-level security and grant the
  application role (`scheduler_app`) access.
- Add rows for both practices to `tests/fixtures/tenancy/two-practices.json`. The cross-practice suite
  (`tests/cross-practice.test.ts`) finds every `practice_id` table and fails for any table that is missing
  the policy or the fixture rows.
- Application code runs queries through `withPracticeTransaction(pool, practiceId, work)`, with
  `practiceId` taken from the authenticated session, never from a request body or model output.
