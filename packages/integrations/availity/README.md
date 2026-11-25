# @scheduler/integrations-availity

Availity REST client and workflows.

## Status (RAH-27)

Built: the transport core (`createAvailityClient`): per-practice token injection from a `CredentialProvider`
port, environment selection (`AVAILITY_ENV`, `AVAILITY_BASE_URL`), `x-scenario-id` in demo, an endpoint
allowlist that always refuses claim submission and remittance paths, error mapping, and PHI-free audit
records through an `AuditSink` port.

Deferred until the real spec is vendored: typed per-endpoint request and response models and methods.

- Put the spec at `openapi/availity-api.yaml` (this package).
- Generate types from it into `src/generated/` (an `openapi-typescript` script in this package's
  `package.json`) and write thin typed methods that call `client.request` with a literal `path`.
- Fill `policy.allowedPrefixes` from the spec's paths, and confirm `transactionIdHeader` (the GTID response
  header) against it. Neither is guessed here.
- Keep claim submission and remittance operations out of the generated surface; the allowlist refuses them
  regardless.
