# HIPAA Security Risk Analysis (Phase 1)

> **DRAFT. Not legal advice. Not reviewed by counsel or a qualified security assessor.**
> This document is a starting point for the HIPAA security officer and counsel. Likelihood and impact ratings are the author's initial estimates, not the result of testing or an audit. Controls listed as "planned" do not exist yet.

Scope: the surgery scheduling agent in the podiatry pilot (office procedure rooms and ASCs). Systems: web app, API, worker, PostgreSQL with row-level security per practice, AWS hosting, Claude through Amazon Bedrock, Redox (EHR), Availity (payers), and the unselected channels in `subprocessors.json`.

Method: asset and data-flow inventory, threat identification, rating (likelihood x impact: low/medium/high), existing or planned controls, residual owner. Review at least annually and on any material change.

## Data inventory

| Asset | PHI | Retention |
| -- | -- | -- |
| Case record and readiness items | Yes | Deleted 90 days after case close |
| Audit log | Scrubbed of PHI by design | 6 years |
| EHR data via Redox | Yes | Mirrors case retention |
| Payer transactions via Availity | Yes | Mirrors case retention |
| Model prompts and completions | Yes | Not stored by us unless logged; see register |
| Payment data | No (never handled) | n/a |

## Risk register

| # | Risk | L | I | Planned or existing control | Status |
| -- | -- | -- | -- | -- | -- |
| 1 | PHI sent to a vendor with no executed BAA | M | H | Register CI check; pilot-ready check; egress deny list | No BAAs signed yet; open |
| 2 | Cross-practice data exposure | M | H | Practice ID on every row, row-level security, per-practice keys | Planned in other issues; open |
| 3 | PHI in logs, traces or model invocation logs | M | H | PHI scrubbing in audit package; logging vendor unselected | Open |
| 4 | Model provider retains prompts (abuse monitoring) | L | H | Confirm terms with AWS; minimize prompt PHI | Unverified; open |
| 5 | Credential or secret compromise | M | H | Vault per practice, no secrets in env vars, MFA | Planned; open |
| 6 | Unauthorized staff access or excessive privilege | M | M | Role-based access, quarterly review (access policy) | Draft policy; open |
| 7 | Misdirected fax or SMS | M | M | Recipient verification, scheduler approval of high-risk steps | Open |
| 8 | Data not deleted on schedule (including backups) | M | M | Retention job, backup expiry aligned to 90 days | Not implemented; open |
| 9 | Breach not detected or reported in time | L | H | Incident response policy, audit alerts | Draft policy; open |
| 10 | Workforce unaware of obligations | M | M | Training policy, sanctions policy | Draft policy; open |
| 11 | Availability loss of the scheduling service | M | M | Multi-AZ, backups, restore tests | Planned; open |
| 12 | Agent takes a wrong high-risk action | M | H | Human approval of high-risk steps, audit trail | Planned; open |

## Next steps

1. Counsel and the security officer review and rewrite this analysis.
2. Execute BAAs and record each in `subprocessors.json` with the stored document reference.
3. Select the unchosen vendors, or design them out, then update the register.
4. Verify model provider and vendor retention terms against executed agreements.
5. Re-rate risks after controls are implemented and tested.
