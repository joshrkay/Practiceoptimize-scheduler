import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EGRESS_DENY_PHI,
  REQUIRED_PHASE1_CATEGORIES,
  checkPilotReady,
  formatIssues,
  loadRegister,
  validateRegister,
  type Subprocessor,
  type SubprocessorRegister,
} from '../../docs/compliance/validate';

const clone = (): SubprocessorRegister => structuredClone(loadRegister());
const find = (r: SubprocessorRegister, id: string): Subprocessor => r.vendors.find((v) => v.id === id)!;

describe('subprocessor register (CI gate)', () => {
  it('Scenario 1: the committed register is complete and consistent', () => {
    const reg = loadRegister();
    expect(validateRegister(reg)).toEqual([]);
    for (const c of REQUIRED_PHASE1_CATEGORIES) {
      expect(reg.vendors.some((v) => v.category === c)).toBe(true);
    }
    for (const v of reg.vendors) {
      expect(v.retention.summary.length).toBeGreaterThan(0);
      expect(v.phiDescription.length).toBeGreaterThan(0);
    }
  });

  it('never records a BAA as signed without an executed document reference', () => {
    for (const v of loadRegister().vendors) {
      if (v.baaStatus === 'signed') expect(v.baaDocumentRef).toBeTruthy();
    }
  });

  it('records known choices and leaves unchosen categories as "to be selected"', () => {
    const reg = loadRegister();
    const unchosen = ['sms', 'efax', 'esignature', 'email', 'logging_observability', 'support_tooling'];
    for (const c of unchosen) {
      const v = reg.vendors.find((x) => x.category === c)!;
      expect(v.vendor).toBe('to be selected');
      expect(v.selected).toBe(false);
    }
    expect(find(reg, 'aws-bedrock-claude').retention.exceptions.join(' ')).toMatch(/abuse/i);
  });

  it('Scenario 2: a vendor with no BAA status fails and is named', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/compliance/vendor-without-baa.json', import.meta.url), 'utf8'),
    );
    const text = formatIssues(validateRegister(fixture));
    expect(text).toContain('acme-sms');
    expect(text).toContain('Acme Messaging (synthetic)');
    expect(text).toMatch(/baaStatus/);
    const ready = checkPilotReady(fixture);
    expect(ready.ready).toBe(false);
    expect(ready.missing[0]!.vendor).toBe('Acme Messaging (synthetic)');
  });

  it('rejects a signed BAA without date or document reference', () => {
    const reg = clone();
    Object.assign(find(reg, 'availity'), { baaStatus: 'signed' });
    const text = formatIssues(validateRegister(reg));
    expect(text).toContain('availity');
    expect(text).toMatch(/baaSignedDate/);
    expect(text).toMatch(/baaDocumentRef/);
  });

  it('accepts a fully evidenced signed BAA', () => {
    const reg = clone();
    Object.assign(find(reg, 'availity'), {
      baaStatus: 'signed',
      baaSignedDate: '2026-12-01',
      baaDocumentRef: 'vault://compliance/baa/availity.pdf',
    });
    expect(validateRegister(reg)).toEqual([]);
  });

  it('rejects bad dates, evidence on non-signed vendors, and unselected signed vendors', () => {
    const reg = clone();
    Object.assign(find(reg, 'availity'), { baaStatus: 'signed', baaSignedDate: '2026-02-31', baaDocumentRef: 'x' });
    Object.assign(find(reg, 'redox'), { baaDocumentRef: 'x' });
    Object.assign(find(reg, 'sms-provider'), {
      baaStatus: 'signed',
      baaSignedDate: '2026-12-01',
      baaDocumentRef: 'x',
    });
    const text = formatIssues(validateRegister(reg));
    expect(text).toMatch(/availity.*valid baaSignedDate/);
    expect(text).toMatch(/redox.*must not carry/);
    expect(text).toMatch(/sms-provider.*not selected/);
  });

  it('requires no_phi vendors to be in EGRESS_DENY_PHI with phiScope none', () => {
    expect(EGRESS_DENY_PHI).toContain('practice-payment-processor');
    const reg = clone();
    expect(formatIssues(validateRegister(reg, []))).toMatch(/practice-payment-processor.*EGRESS_DENY_PHI/);
    find(reg, 'practice-payment-processor').phiScope = 'phi';
    expect(formatIssues(validateRegister(reg))).toMatch(/phiScope "none"/);
  });

  it('rejects deny-listed vendors that are not no_phi, and orphan deny entries', () => {
    const text = formatIssues(validateRegister(clone(), [...EGRESS_DENY_PHI, 'availity', 'ghost']));
    expect(text).toMatch(/availity.*not marked no_phi/);
    expect(text).toMatch(/ghost.*no register vendor/);
  });

  it('rejects structural problems: duplicates, missing retention, missing category, bad shape', () => {
    const reg = clone();
    reg.vendors.push(structuredClone(find(reg, 'redox')));
    delete (find(reg, 'availity') as Partial<Subprocessor>).retention;
    reg.vendors = reg.vendors.filter((v) => v.category !== 'email');
    reg.lastReviewed = 'yesterday';
    const text = formatIssues(validateRegister(reg));
    expect(text).toMatch(/duplicate vendor id/);
    expect(text).toMatch(/availity.*retention/);
    expect(text).toMatch(/category email/);
    expect(text).toMatch(/lastReviewed/);
    expect(formatIssues(validateRegister({}))).toMatch(/vendors must be an array/);
    expect(validateRegister({ lastReviewed: '2026-01-01', vendors: [null] }).length).toBeGreaterThan(0);
  });
});

describe('pilot-ready check (readiness report, not a CI gate)', () => {
  it('reports every Phase 1 vendor that is neither signed nor no_phi', () => {
    const reg = loadRegister();
    const result = checkPilotReady(reg);
    const expected = reg.vendors.filter((v) => v.baaStatus === 'pending').map((v) => v.id);
    expect(result.missing.map((m) => m.vendorId)).toEqual(expected);
    expect(result.ready).toBe(expected.length === 0);
    const text = formatIssues(result.missing);
    expect(text).toContain('Amazon Web Services');
    expect(text).toContain('no vendor is selected yet');
  });

  it('is ready once every Phase 1 vendor is signed or no_phi, and ignores later phases', () => {
    const reg = clone();
    for (const v of reg.vendors) {
      if (v.baaStatus === 'pending') {
        Object.assign(v, { baaStatus: 'signed', baaSignedDate: '2026-12-01', baaDocumentRef: 'vault://x' });
      }
    }
    expect(checkPilotReady(reg)).toEqual({ ready: true, missing: [] });
    const later = clone();
    for (const v of later.vendors) v.phase = 2;
    expect(checkPilotReady(later).ready).toBe(true);
  });
});
