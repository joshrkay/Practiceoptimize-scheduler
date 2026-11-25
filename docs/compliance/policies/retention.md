# Data Retention and Disposal Policy

> **DRAFT. Not legal advice. Not reviewed by counsel.** Periods reflect current product decisions and must be confirmed by counsel and each practice's agreement; not yet adopted. The deletion jobs described are not confirmed to be implemented.

| Data | Retention |
| -- | -- |
| Case PHI (case record, readiness items, documents) | Deleted 90 days after case close |
| Audit log (PHI-scrubbed) | 6 years |
| HIPAA policies, training and incident records | 6 years |
| Backups and snapshots containing case PHI | Expire within the same 90-day window |
| Vendor-held data | Per executed agreement, recorded in `subprocessors.json` |

1. The EHR is the system of record; our copies are working copies.
2. Deletion covers primary stores, derived data, caches, and backups. Deletion is logged without PHI.
3. Media and keys: per-practice encryption keys are destroyed on practice offboarding after data return.
4. A legal hold, notified by counsel, suspends deletion for the affected data only.
5. Any vendor whose retention exceeds ours, including model provider abuse-monitoring exceptions, is recorded in the register and disclosed to practices.

**Owner:** HIPAA security officer. **Review:** annually.
