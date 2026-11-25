/**
 * Subprocessor register schema and validators.
 *
 * Two separate checks:
 *  - validateRegister: schema and consistency rules. Runs in CI and must pass.
 *  - checkPilotReady: every Phase 1 vendor must be `signed` or `no_phi`. This is a readiness
 *    report, not a CI gate; it lists what is still missing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type BaaStatus = 'signed' | 'pending' | 'no_phi';
export type PhiScope = 'phi' | 'none';

export interface RetentionTerms {
  summary: string;
  verified: boolean;
  exceptions: string[];
}

export interface Subprocessor {
  id: string;
  category: string;
  vendor: string;
  selected: boolean;
  phase: number;
  phiScope: PhiScope;
  phiDescription: string;
  baaStatus: BaaStatus;
  baaSignedDate: string | null;
  baaDocumentRef: string | null;
  retention: RetentionTerms;
}

export interface SubprocessorRegister {
  lastReviewed: string;
  vendors: Subprocessor[];
}

/**
 * Vendor ids that integration code must refuse to send PHI to. Every `no_phi` vendor must be
 * listed here and nothing else may be.
 */
export const EGRESS_DENY_PHI: readonly string[] = ['practice-payment-processor'];

export const REQUIRED_PHASE1_CATEGORIES: readonly string[] = [
  'cloud_hosting',
  'model_provider',
  'payer_connectivity',
  'ehr_integration',
  'payments',
  'sms',
  'efax',
  'esignature',
  'email',
  'logging_observability',
  'support_tooling',
];

export interface ValidationIssue {
  vendorId: string;
  vendor: string;
  message: string;
}

const BAA_STATUSES: readonly string[] = ['signed', 'pending', 'no_phi'];
const PHI_SCOPES: readonly string[] = ['phi', 'none'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function validDate(v: unknown): boolean {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

function validateVendor(raw: unknown, index: number, denyList: readonly string[]): ValidationIssue[] {
  const v = (raw ?? {}) as Record<string, unknown>;
  const id = nonEmpty(v.id) ? v.id : `#${index}`;
  const name = nonEmpty(v.vendor) ? v.vendor : id;
  const issues: ValidationIssue[] = [];
  const bad = (message: string) => issues.push({ vendorId: id, vendor: name, message });

  for (const f of ['id', 'category', 'vendor', 'phiDescription']) {
    if (!nonEmpty(v[f])) bad(`missing ${f}`);
  }
  if (typeof v.selected !== 'boolean') bad('missing selected flag');
  if (!Number.isInteger(v.phase)) bad('missing phase');
  if (!PHI_SCOPES.includes(v.phiScope as string)) bad('missing or invalid phiScope');
  if (!BAA_STATUSES.includes(v.baaStatus as string)) {
    bad('missing or invalid baaStatus (must be signed, pending or no_phi)');
  }

  const r = v.retention as Record<string, unknown> | undefined;
  if (!r || !nonEmpty(r.summary) || typeof r.verified !== 'boolean' || !Array.isArray(r.exceptions)) {
    bad('missing or incomplete retention terms');
  }

  const signedDate = v.baaSignedDate ?? null;
  const docRef = v.baaDocumentRef ?? null;
  if (v.baaStatus === 'signed') {
    if (!validDate(signedDate)) bad('signed BAA requires a valid baaSignedDate');
    if (!nonEmpty(docRef)) bad('signed BAA requires baaDocumentRef (storage reference of the executed document)');
    if (v.selected === false) bad('a vendor that is not selected cannot have a signed BAA');
  } else if (BAA_STATUSES.includes(v.baaStatus as string)) {
    if (signedDate !== null || docRef !== null) {
      bad(`${String(v.baaStatus)} vendor must not carry baaSignedDate or baaDocumentRef`);
    }
  }

  if (v.baaStatus === 'no_phi') {
    if (v.phiScope !== 'none') bad('no_phi vendor must have phiScope "none"');
    if (!denyList.includes(id)) bad('no_phi vendor must be listed in EGRESS_DENY_PHI');
  } else if (denyList.includes(id)) {
    bad('vendor is in EGRESS_DENY_PHI but is not marked no_phi');
  }

  return issues;
}

/** Schema and consistency validation. Returns all issues; empty means valid. */
export function validateRegister(
  register: unknown,
  denyList: readonly string[] = EGRESS_DENY_PHI,
): ValidationIssue[] {
  const reg = (register ?? {}) as Partial<SubprocessorRegister>;
  const issues: ValidationIssue[] = [];
  if (!validDate(reg.lastReviewed)) {
    issues.push({ vendorId: '-', vendor: '-', message: 'register lastReviewed must be YYYY-MM-DD' });
  }
  if (!Array.isArray(reg.vendors)) {
    issues.push({ vendorId: '-', vendor: '-', message: 'register vendors must be an array' });
    return issues;
  }
  const seen = new Set<string>();
  reg.vendors.forEach((raw, i) => {
    issues.push(...validateVendor(raw, i, denyList));
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id === 'string') {
      if (seen.has(id)) issues.push({ vendorId: id, vendor: id, message: 'duplicate vendor id' });
      seen.add(id);
    }
  });
  for (const d of denyList) {
    if (!seen.has(d)) issues.push({ vendorId: d, vendor: d, message: 'EGRESS_DENY_PHI entry has no register vendor' });
  }
  const cats = new Set(reg.vendors.map((x) => (x as { category?: string } | null)?.category));
  for (const c of REQUIRED_PHASE1_CATEGORIES) {
    if (!cats.has(c)) issues.push({ vendorId: '-', vendor: '-', message: `no vendor recorded for Phase 1 category ${c}` });
  }
  return issues;
}

export interface PilotReadiness {
  ready: boolean;
  missing: ValidationIssue[];
}

/** Pilot-ready check: every Phase 1 vendor must be `signed` or `no_phi`. */
export function checkPilotReady(register: SubprocessorRegister): PilotReadiness {
  const missing: ValidationIssue[] = [];
  for (const v of register.vendors) {
    if (v.phase !== 1) continue;
    if (v.baaStatus === 'signed' || v.baaStatus === 'no_phi') continue;
    const sel = v.selected ? '' : ' and no vendor is selected yet';
    missing.push({
      vendorId: v.id,
      vendor: v.vendor,
      message: `${v.category}: BAA status is ${String(v.baaStatus ?? 'missing')}${sel}`,
    });
  }
  return { ready: missing.length === 0, missing };
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.vendorId} (${i.vendor}): ${i.message}`).join('\n');
}

export function loadRegister(path?: string): SubprocessorRegister {
  const p = path ?? fileURLToPath(new URL('./subprocessors.json', import.meta.url));
  return JSON.parse(readFileSync(p, 'utf8')) as SubprocessorRegister;
}
