# @scheduler/integrations-ehr

EHR connectors and write-back. All Phase 1 EHR access goes through Redox, behind `EhrConnector`.
Never call an EHR directly.

## Pieces

| File | What it is |
| -- | -- |
| `src/connector.ts` | `EhrConnector`: orders, patient, coverage, documents, appointments, open slots, booking, chart write-back, in-basket messages |
| `src/capabilities.ts` | Capabilities, the provisional `PILOT_CAPABILITY_MATRIX`, and `unsupported()` (result with a workspace task) |
| `src/locations.ts` | `LocationSourceMap`: (practice, location) to EHR source; one practice can have locations on different EHRs |
| `src/ports.ts` | `CredentialProvider` (vault), `WorkspaceTaskSink`, `RedoxInboundMessageStore`, `resolveOrCreateTask`, in-memory fakes |
| `src/fake/` | `InMemoryEhrConnector` |
| `src/redox/` | `RedoxEhrConnector`, `RedoxTransport`, message mapping, `loadEhrConfig` (`EHR_PROVIDER`, `REDOX_ENV`) |
| `tests/contract/ehr-connector-contract.ts` | `describeEhrConnectorContract(name, makeHarness)`: the suite every implementation must pass (also exported as `@scheduler/integrations-ehr/contract`) |

## The capability rule

Every call returns `ok`, `error`, or `unsupported`. `unsupported` carries a `workspaceTask`; callers pass the
result to `resolveOrCreateTask(result, tasks)` so a gap becomes a task for the scheduler, never a silent no-op.

## Redox status

See `REDOX_OPERATIONS` in `src/redox/connector.ts`. Implemented: inbound `Order` (New/Update/Cancel),
`PatientSearch` / `Query`, `Notes` / `New`, OAuth client-credentials with a vault-signed client assertion.
Everything else is a placeholder that returns `unsupported` (`connector_pending_verification`) until verified
in a Redox sandbox. Fixtures in `tests/fixtures/redox/` are synthetic and not captured from Redox.
