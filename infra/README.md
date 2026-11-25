# Infrastructure

AWS CDK (TypeScript), HIPAA-eligible services only. See RAH-6.

- `kms/`: platform keys (rotation on). `network/`: VPC, egress allowlist (Network Firewall), VPC endpoints (Bedrock, KMS, ...), WAF.
- `data/`: PostgreSQL, AWS Backup vault, encrypted bucket and queues. `secrets/`: vault namespace and read policy.
- `environments/`: dev, staging, prod built from one stack set. `lib/config.ts`: per-environment settings.
- `policy/rules.ts`: policy-as-code rules over synthesized templates. `tests/policy/` runs them against every environment and against a deliberately bad stack.

Deploy: `INFRA_ENV=<dev|staging|prod> [EGRESS_ALLOWLIST=.availity.com,...] npx cdk deploy --all` (needs AWS credentials; not run here).
Checks: `npm run test -- infra/tests`. A public database, unencrypted bucket or queue, or open ingress fails with `[rule-id] stack/resource`.
