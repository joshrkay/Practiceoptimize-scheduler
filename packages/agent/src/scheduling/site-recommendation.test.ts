import { describe, expect, it } from 'vitest';
import { createInMemorySchedulingPorts } from './fakes.js';
import { recommendSite } from './site-recommendation.js';
import { caseFrom, loadFixture } from './test-fixture.js';

const codes = (reasons: { code: string }[]) => reasons.map((r) => r.code);

describe('recommendSite', () => {
  it('recommends the in-network ASC with privileges for a low-risk bunionectomy, with reasons', async () => {
    const fx = loadFixture();
    const rec = await recommendSite(caseFrom(fx, 'case-bunion-low'), createInMemorySchedulingPorts(fx), fx.now);

    expect(rec.selection).toBe('agent');
    expect(rec.recommended?.site.id).toBe('site-asc-mesa');
    expect(rec.recommended?.site.kind).toBe('asc');
    expect(rec.recommended?.rank).toBe(1);
    expect(rec.recommended?.preferenceRank).toBe(2);
    expect(rec.recommended?.privilegeValidUntil).toBe('2027-06-30T23:59:59.000Z');
    expect(codes(rec.recommended?.reasons ?? [])).toEqual([
      'in_network',
      'site_of_service_allowed',
      'privileges',
      'anesthesia_supported',
      'surgeon_preference',
    ]);
    expect(rec.options.map((o) => o.site.id)).toEqual(['site-asc-mesa']);

    const excluded = Object.fromEntries(rec.excluded.map((e) => [e.site.id, codes(e.reasons)]));
    expect(excluded).toEqual({
      'site-office-pr': ['anesthesia_not_supported'],
      'site-asc-saguaro': ['out_of_network'],
      'site-asc-paloverde': ['no_privileges'],
      'site-hospital-valley': ['hospital_out_of_scope'],
    });
    // Another practice's site is never considered or mentioned.
    expect([...rec.options, ...rec.excluded].some((o) => o.site.practiceId !== fx.practiceId)).toBe(false);
    expect(rec.notes).toEqual([]);
  });

  it('lists options with reasons but makes site choice human-only for a high-risk patient', async () => {
    const fx = loadFixture();
    const rec = await recommendSite(caseFrom(fx, 'case-bunion-high'), createInMemorySchedulingPorts(fx), fx.now);

    expect(rec.selection).toBe('human_only');
    expect(rec.recommended).toBeNull();
    expect(rec.highRiskFlags).toEqual(['asa_3']);
    expect(rec.options.map((o) => o.site.id)).toEqual(['site-asc-mesa']);
    expect(rec.options[0]?.reasons.length).toBeGreaterThan(0);
    expect(codes(rec.notes)).toEqual(['high_risk_human_only']);
    expect(rec.notes[0]?.message).toContain('asa_3');
  });

  it('never makes a hospital a candidate, even when it is the only in-network site with privileges', async () => {
    const fx = loadFixture();
    fx.sites = fx.sites.filter((s) => s.kind === 'hospital');
    const rec = await recommendSite(caseFrom(fx, 'case-bunion-low'), createInMemorySchedulingPorts(fx), fx.now);
    expect(rec.options).toEqual([]);
    expect(rec.recommended).toBeNull();
    expect(codes(rec.notes)).toEqual(['no_eligible_site']);
  });

  it('excludes sites that do not accept a patient risk flag', async () => {
    const fx = loadFixture();
    fx.riskFlags['case-bunion-low'] = ['bmi_over_40'];
    fx.highRiskFlags = [];
    const rec = await recommendSite(caseFrom(fx, 'case-bunion-low'), createInMemorySchedulingPorts(fx), fx.now);
    const mesa = rec.excluded.find((e) => e.site.id === 'site-asc-mesa');
    expect(codes(mesa?.reasons ?? [])).toEqual(['risk_flag_excluded']);
    expect(rec.recommended).toBeNull();
  });

  it('applies the payer site-of-service rule', async () => {
    const fx = loadFixture();
    fx.siteOfServiceRules[0]!.rule = { allowedSiteKinds: ['office_procedure_room'], source: 'office-only policy' };
    const rec = await recommendSite(caseFrom(fx, 'case-bunion-low'), createInMemorySchedulingPorts(fx), fx.now);
    const mesa = rec.excluded.find((e) => e.site.id === 'site-asc-mesa');
    expect(codes(mesa?.reasons ?? [])).toEqual(['site_of_service_not_allowed']);
    expect(mesa?.reasons[0]?.message).toContain('office-only policy');
  });

  it('excludes every site when coverage is inactive or unknown', async () => {
    const fx = loadFixture();
    const c = { ...caseFrom(fx, 'case-bunion-low'), patientId: 'patient-inactive' };
    const rec = await recommendSite(c, createInMemorySchedulingPorts(fx), fx.now);
    expect(rec.options).toEqual([]);
    const mesa = rec.excluded.find((e) => e.site.id === 'site-asc-mesa');
    expect(codes(mesa?.reasons ?? [])).toEqual(['coverage_not_active']);

    const none = await recommendSite({ ...c, patientId: 'patient-missing' }, createInMemorySchedulingPorts(fx), fx.now);
    expect(none.options).toEqual([]);
  });

  it('treats a facility with unknown network status as ineligible', async () => {
    const fx = loadFixture();
    delete fx.coverage['patient-low']!.facilityNetwork['site-asc-mesa'];
    const rec = await recommendSite(caseFrom(fx, 'case-bunion-low'), createInMemorySchedulingPorts(fx), fx.now);
    const mesa = rec.excluded.find((e) => e.site.id === 'site-asc-mesa');
    expect(codes(mesa?.reasons ?? [])).toEqual(['network_unknown']);
  });

  it('excludes a site where privileges have expired or are not granted', async () => {
    const fx = loadFixture();
    fx.privileges.find((p) => p.facilityId === 'site-asc-mesa')!.validUntil = '2026-11-30T00:00:00.000Z';
    fx.privileges.find((p) => p.facilityId === 'site-office-pr')!.granted = false;
    const rec = await recommendSite(caseFrom(fx, 'case-hammertoe-local'), createInMemorySchedulingPorts(fx), fx.now);
    const byId = Object.fromEntries(rec.excluded.map((e) => [e.site.id, codes(e.reasons)]));
    expect(byId['site-asc-mesa']).toEqual(['privileges_expired']);
    expect(byId['site-office-pr']).toEqual(['no_privileges']);
  });

  it('ranks by surgeon preference, then by anesthesia fit (office for a local-only case)', async () => {
    const fx = loadFixture();
    const c = caseFrom(fx, 'case-hammertoe-local');
    // No payer rule for 28285, so the payer places no restriction.
    const ranked = await recommendSite(c, createInMemorySchedulingPorts(fx), fx.now);
    expect(ranked.options.map((o) => o.site.id)).toEqual(['site-asc-mesa', 'site-office-pr']);
    expect(ranked.options[0]?.reasons.find((r) => r.code === 'site_of_service_allowed')?.message).toContain(
      'no site-of-service restriction',
    );

    fx.surgeonPreferences['surgeon-ramos']!.preferredSiteIds = [];
    const unranked = await recommendSite(c, createInMemorySchedulingPorts(fx), fx.now);
    expect(unranked.options.map((o) => [o.site.id, o.preferenceRank])).toEqual([
      ['site-office-pr', null],
      ['site-asc-mesa', null],
    ]);
    expect(codes(unranked.options[0]?.reasons ?? [])).toContain('not_preferred');
    expect(unranked.options[0]?.reasons.find((r) => r.code === 'privileges')?.message).not.toContain('through');
  });

  it('is deterministic for the same inputs', async () => {
    const fx = loadFixture();
    const ports = createInMemorySchedulingPorts(fx);
    const c = caseFrom(fx, 'case-bunion-low');
    expect(await recommendSite(c, ports, fx.now)).toEqual(await recommendSite(c, ports, fx.now));
  });

  it('returns nothing for a practice the ports do not serve', async () => {
    const fx = loadFixture();
    const c = { ...caseFrom(fx, 'case-bunion-low'), practiceId: 'practice-other' };
    const rec = await recommendSite(c, createInMemorySchedulingPorts(fx), fx.now);
    expect(rec.options).toEqual([]);
    expect(rec.excluded).toEqual([]);
  });
});
