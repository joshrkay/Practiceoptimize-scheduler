import { describe, expect, it } from 'vitest';
import type { CaseSnapshot, JourneyStep } from './journey.js';
import { PODIATRY_JOURNEY, computeDueAt, findStep, isApproveFirst, stepsForStage } from './journey.js';

const ascCase: CaseSnapshot = {
  practiceId: 'practice-a',
  caseId: 'case-1',
  stage: 'scheduled',
  surgeryDate: '2027-02-10',
  siteOfService: 'asc',
  flags: ['implant', 'clearance_required'],
};

describe('PODIATRY_JOURNEY', () => {
  it('contacts the OR desk, vendor rep, anesthesia and primary care when an ASC case is scheduled', () => {
    expect(stepsForStage(PODIATRY_JOURNEY, 'scheduled', ascCase).map((step) => step.partyRole)).toEqual([
      'facility_or_desk',
      'vendor_rep',
      'anesthesia',
      'primary_care',
    ]);
  });

  it('skips facility posting and anesthesia for an office procedure room case without flags', () => {
    const office: CaseSnapshot = { ...ascCase, siteOfService: 'office', flags: [] };
    expect(stepsForStage(PODIATRY_JOURNEY, 'scheduled', office)).toEqual([]);
  });

  it('contacts the surgeon for a peer-to-peer when authorization is denied', () => {
    expect(stepsForStage(PODIATRY_JOURNEY, 'authorization_denied', ascCase).map((step) => step.type)).toEqual([
      'peer_to_peer',
    ]);
  });

  it('finds steps by id', () => {
    expect(findStep(PODIATRY_JOURNEY, 'vendor-rep')?.partyRole).toBe('vendor_rep');
    expect(findStep(PODIATRY_JOURNEY, 'nope')).toBeUndefined();
  });
});

describe('isApproveFirst', () => {
  it('always holds facility postings and peer-to-peers, even if a step says otherwise', () => {
    expect(isApproveFirst({ type: 'facility_posting' })).toBe(true);
    expect(isApproveFirst({ type: 'peer_to_peer', approveFirst: false })).toBe(true);
    expect(isApproveFirst({ type: 'clearance' })).toBe(false);
    expect(isApproveFirst({ type: 'clearance', approveFirst: true })).toBe(true);
  });

  it('is set for every facility posting and peer-to-peer step in the journey', () => {
    const held = PODIATRY_JOURNEY.steps.filter((step: JourneyStep) => isApproveFirst(step)).map((step) => step.id);
    expect(held).toEqual(['facility-posting', 'peer-to-peer']);
  });
});

describe('computeDueAt', () => {
  const created = new Date('2027-01-04T15:00:00.000Z');
  it('counts back from the surgery date', () => {
    expect(computeDueAt({ due: { daysBeforeSurgery: 7 } }, '2027-02-10', created).toISOString()).toBe(
      '2027-02-03T00:00:00.000Z',
    );
  });
  it('counts forward from creation', () => {
    expect(computeDueAt({ due: { hoursAfterSend: 48 } }, '2027-02-10', created).toISOString()).toBe(
      '2027-01-06T15:00:00.000Z',
    );
  });
});
