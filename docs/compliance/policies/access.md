# Access Control Policy

> **DRAFT. Not legal advice. Not reviewed by counsel.** Starting point for the security officer and counsel; not yet adopted.

**Purpose.** Limit access to PHI to people and systems that need it.

1. Access is role-based and granted on the minimum necessary basis. Each practice is an isolation boundary; no user may see another practice's data.
2. Every user has a unique identity and multi-factor authentication. Shared accounts are prohibited.
3. Access requests are approved by the security officer and recorded. Access is removed within one business day of role change or departure.
4. Production data access by staff is exceptional, time-limited, and audited. Secrets live in the practice's vault path, never in environment variables or source.
5. Access rights are reviewed at least quarterly. Findings are recorded.
6. All PHI access is written to the audit log, retained 6 years.
7. Sessions time out after inactivity; devices accessing PHI use disk encryption.

**Owner:** HIPAA security officer. **Review:** annually.
