# Working in this repository

AI surgery scheduling agent: moves each surgical case from order to post-op follow-up, with schedulers
approving the high-risk steps. Podiatry-first pilot in office procedure rooms and ASCs.

## Layout

| Path | Purpose |
| -- | -- |
| `apps/web/` | Scheduler workspace (Next.js) |
| `apps/api/` | HTTP API, auth, webhooks |
| `apps/worker/` | Async jobs, polling, scheduled syncs |
| `packages/case-model/` | Case record, state machine, readiness model |
| `packages/agent/` | Planner, policy engine, tool layer, review queue |
| `packages/tenancy/` | Organization, practice, location, facility, settings inheritance |
| `packages/db/` | Schema, migrations, row-level security policies |
| `packages/audit/` | Immutable audit log, PHI scrubbing |
| `packages/integrations/{availity,ehr,fax,portals}/` | External systems |
| `packages/fhir/` | FHIR R4 builders and validators (Da Vinci CRD, DTR, PAS) |
| `infra/` | Infrastructure as code |
| `evals/` | Evaluation harness and replay cases |
| `tests/fixtures/` | Synthetic test data only |

Packages import each other as `@scheduler/<name>` (see `tsconfig.base.json` and `vitest.config.ts`;
a new package must be added to both).

## Commands (every change must pass these)

- `npm run type-check` — 0 errors
- `npm run lint -- --fix`
- `npm run test -- <path>` — all assertions pass
- `npm run test:coverage -- <path>` — modified lines at least 90%
- `npm run evals -- <suite>` — for agent behavior changes

## Rules

- No real PHI anywhere: code, fixtures, logs, commits, issue comments. Synthetic data only.
- Never weaken practice isolation, audit logging, or PHI scrubbing to make a test pass.
- Do not change another package's public interface unless the issue says so.
- If you find an unrelated bug, write it up and stop; do not fix it on the same branch.
- If tests still fail after 3 attempts, stop and report the failing assertions.
- Feature flags are `FEATURE_<NAME>` and default to `false` in production.
- Secrets and tokens are never environment variables; they live in the practice's vault path.

## Language

Use the project glossary in code, UI copy, and docs: **practice** (the customer and isolation boundary;
existing issues sometimes say "tenant", meaning the same thing), **location**, **facility**,
**site of service**, **surgeon**, **scheduler**, **case**, **case series**, **order**, **readiness item**,
**readiness rule**, **authorization**, **change plan**, **coordination request**, **specialty pack**.

## Decisions already made

1. Podiatry-first pilot; office procedure rooms and ASCs; hospitals out of scope.
2. All Phase 1 EHR access goes through Redox, behind our own connector interface.
3. Availity REST through our typed tool layer, not Availity's MCP server.
4. The practice is the isolation boundary: practice ID on every row, PostgreSQL row-level security,
   per-practice encryption key and vault path.
5. The EHR is the system of record; case PHI is deleted 90 days after close; the audit log is kept 6 years.
6. AWS HIPAA-eligible services; Claude through Amazon Bedrock; TypeScript monorepo.
7. A surgeon's signed urgent order approves an urgent add-on; no after-hours paging in Phase 1.
8. Payments only through the practice's own processor; we never handle card data.

## Database tests

Tests that need PostgreSQL read `DATABASE_URL` (see `.env.example`; CI provides a `postgres:16` service).
Each test file must create and drop its own uniquely named schema or database so files can run in parallel.
