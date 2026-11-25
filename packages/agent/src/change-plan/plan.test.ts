import { describe, expect, it } from 'vitest';
import {
  approveChangePlan,
  buildChangePlan,
  isRescheduleCascadeEnabled,
  rejectChangePlan,
  RESCHEDULE_CASCADE_FLAG,
} from './plan.js';
import type { FakeCascadeWorld } from './fakes.js';
import type { Approver, CaseSnapshot, ChangePlan } from './model.js';
import { loadFixture } from './test-fixtures.js';

const ON = { featureEnabled: true };
const SCHEDULER: Approver = { type: 'human', userId: 'user-scheduler-01', role: 'scheduler' };
const POLICY: Approver = { type: 'delegated_policy', policyId: 'policy-same-day-swap' };

async function sitePlan(): Promise<{ plan: ChangePlan; world: FakeCascadeWorld }> {
  const { fixture, world } = loadFixture('site-change');
  return { plan: await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON), world };
}

describe('feature flag', () => {
  it('is on only when FEATURE_RESCHEDULE_CASCADE is exactly "true"', () => {
    expect(RESCHEDULE_CASCADE_FLAG).toBe('FEATURE_RESCHEDULE_CASCADE');
    expect(isRescheduleCascadeEnabled({})).toBe(false);
    expect(isRescheduleCascadeEnabled({ FEATURE_RESCHEDULE_CASCADE: '1' })).toBe(false);
    expect(isRescheduleCascadeEnabled({ FEATURE_RESCHEDULE_CASCADE: 'true' })).toBe(true);
  });

  it('refuses to build a plan when the flag is off', async () => {
    const { fixture, world } = loadFixture('site-change');
    await expect(
      buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), { featureEnabled: false }),
    ).rejects.toMatchObject({ code: 'feature_disabled' });
  });
});

describe('buildChangePlan inputs', () => {
  it('rejects an unknown case and a case from another practice', async () => {
    const { fixture, world } = loadFixture('site-change');
    await expect(
      buildChangePlan(fixture.practiceId, { type: 'cancellation', caseId: 'case-missing', reason: 'x' }, world.planningPorts(), ON),
    ).rejects.toMatchObject({ code: 'case_not_found' });
    await expect(
      buildChangePlan('practice-other', fixture.change, world.planningPorts(), ON),
    ).rejects.toMatchObject({ code: 'case_not_found' });
  });

  it('rejects a change to a cancelled case', async () => {
    const { fixture, world } = loadFixture('site-change');
    const c = world.cases.get('case-hammertoe-0002') as CaseSnapshot;
    world.cases.set(c.caseId, { ...c, status: 'Cancelled' });
    await expect(buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON)).rejects.toMatchObject({
      code: 'case_not_active',
    });
  });

  it('rejects a surgeon-calendar change with no cases that day', async () => {
    const { fixture, world } = loadFixture('surgeon-out-sick');
    await expect(
      buildChangePlan(
        fixture.practiceId,
        { type: 'surgeon_calendar', surgeonId: 'surgeon-dpm-001', date: '2026-12-25', reason: 'Out' },
        world.planningPorts(),
        ON,
      ),
    ).rejects.toMatchObject({ code: 'no_cases_affected' });
  });
});

describe('effects per change type', () => {
  it('procedure change that still fits keeps the slot and re-submits auth for the new code', async () => {
    const { fixture, world } = loadFixture('site-change');
    const plan = await buildChangePlan(
      fixture.practiceId,
      {
        type: 'procedure',
        caseId: 'case-hammertoe-0002',
        procedure: { cptCodes: ['28285', '28270'], description: 'Hammertoe correction with capsulotomy', durationMinutes: 60 },
      },
      world.planningPorts(),
      ON,
    );
    const effect = plan.cases[0]!;
    expect(effect.newSlot?.slotId).toBe('slot-opr-20261215-0900');
    expect(effect.reentryStatus).toBe('Auth pending');
    expect(effect.notes.join(' ')).toContain('28285, 28270');
    const kinds = plan.steps.map((s) => s.action.kind);
    expect(kinds).toContain('resubmit_authorization');
    expect(kinds).not.toContain('release_slot_to_waitlist');
    expect(kinds).not.toContain('move_post_op_visit');
    expect(plan.steps.find((s) => s.action.kind === 'notify_patient')?.action).toMatchObject({
      template: 'case_details_changed',
    });
    expect(world.slotQueries).toEqual([]);
  });

  it('longer procedure asks the slot finder for a longer slot', async () => {
    const { fixture, world } = loadFixture('site-change');
    world.slots.push({
      slotId: 'slot-opr-20261215-1300',
      facilityId: 'office-pr-1',
      siteOfService: 'office_procedure_room',
      surgeonId: 'surgeon-dpm-001',
      start: '2026-12-15T13:00:00.000Z',
      end: '2026-12-15T15:00:00.000Z',
    });
    const plan = await buildChangePlan(
      fixture.practiceId,
      {
        type: 'procedure',
        caseId: 'case-hammertoe-0002',
        procedure: { cptCodes: ['28285'], description: 'Hammertoe correction, two toes', durationMinutes: 100 },
      },
      world.planningPorts(),
      ON,
    );
    expect(world.slotQueries[0]?.durationMinutes).toBe(100);
    expect(plan.cases[0]?.newSlot?.slotId).toBe('slot-opr-20261215-1300');
  });

  it('surgeon change finds a slot for the new surgeon and updates the team', async () => {
    const { fixture, world } = loadFixture('date-move-outside-auth');
    world.slots.push({
      slotId: 'slot-asc-20261210-1400-b',
      facilityId: 'asc-sunrise-foot',
      siteOfService: 'asc',
      surgeonId: 'surgeon-dpm-002',
      start: '2026-12-10T14:00:00.000Z',
      end: '2026-12-10T16:00:00.000Z',
    });
    const plan = await buildChangePlan(
      fixture.practiceId,
      { type: 'surgeon', caseId: 'case-bunion-0001', surgeonId: 'surgeon-dpm-002' },
      world.planningPorts(),
      ON,
    );
    const effect = plan.cases[0]!;
    expect(effect.newSlot?.surgeonId).toBe('surgeon-dpm-002');
    expect(effect.reentryStatus).toBe('Booked');
    expect(effect.expiringReadinessItemIds).toEqual([]);
    expect(effect.notes.join(' ')).toContain('surgeon-dpm-001 to surgeon-dpm-002');
    const coord = plan.steps.filter((s) => s.action.kind === 'update_coordination_request');
    expect(coord.map((s) => s.action)).toEqual([
      expect.objectContaining({ party: 'vendor', surgeonId: 'surgeon-dpm-002' }),
      expect.objectContaining({ party: 'team', surgeonId: 'surgeon-dpm-002' }),
    ]);
  });

  it('a case with no authorization on file always re-enters at Auth pending', async () => {
    const { fixture, world } = loadFixture('site-change');
    const c = world.cases.get('case-hammertoe-0002') as CaseSnapshot;
    const { authorization: _drop, ...noAuth } = c;
    world.cases.set(c.caseId, noAuth);
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);
    expect(plan.cases[0]?.reentryStatus).toBe('Auth pending');
  });

  it('an authorization tied to the old facility is re-submitted on a site change', async () => {
    const { fixture, world } = loadFixture('site-change');
    const c = world.cases.get('case-hammertoe-0002') as CaseSnapshot;
    world.cases.set(c.caseId, { ...c, authorization: { ...c.authorization!, facilityId: 'office-pr-1' } });
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);
    expect(plan.cases[0]?.authorizationResubmission).toBe(true);
  });

  it('a cancellation outside a series has no series note and no post-op step when none is booked', async () => {
    const { fixture, world } = loadFixture('site-change');
    const c = world.cases.get('case-hammertoe-0002') as CaseSnapshot;
    const { postOpVisit: _drop, ...noPostOp } = c;
    world.cases.set(c.caseId, noPostOp);
    const plan = await buildChangePlan(
      fixture.practiceId,
      { type: 'cancellation', caseId: c.caseId, reason: 'Resolved with conservative care' },
      world.planningPorts(),
      ON,
    );
    expect(plan.cases[0]?.notes).toEqual(['Cancellation reason: Resolved with conservative care']);
    expect(plan.steps.map((s) => s.action.kind)).not.toContain('cancel_post_op_visit');
  });

  it('no open slot makes a blocker and the plan cannot be approved', async () => {
    const { fixture, world } = loadFixture('date-move-outside-auth');
    world.slots = [];
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);
    expect(plan.steps).toEqual([]);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.cases[0]?.newSlot).toBeUndefined();
    expect(() => approveChangePlan(plan, SCHEDULER, world.nowIso)).toThrow(/cannot be approved/);
  });

  it('a series follower with no slot blocks the whole plan', async () => {
    const { fixture, world } = loadFixture('series-move');
    world.slots = world.slots.filter((s) => s.slotId === 'slot-asc-20261217-0800');
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);
    expect(plan.cases.map((c) => c.caseId)).toEqual(['case-series-1', 'case-series-2']);
    expect(plan.blockers[0]).toContain('case-series-2');
  });

  it('series followers are not proposed when the move keeps the same start', async () => {
    const { fixture, world } = loadFixture('series-move');
    world.slots.push({
      slotId: 'slot-asc-20261210-0800',
      facilityId: 'asc-sunrise-foot',
      siteOfService: 'asc',
      surgeonId: 'surgeon-dpm-001',
      start: '2026-12-10T08:00:00.000Z',
      end: '2026-12-10T10:00:00.000Z',
    });
    const plan = await buildChangePlan(
      fixture.practiceId,
      { type: 'surgeon', caseId: 'case-series-1', surgeonId: 'surgeon-dpm-001' },
      world.planningPorts(),
      ON,
    );
    expect(plan.cases.map((c) => c.caseId)).toEqual(['case-series-1']);
  });

  it('surgeon calendar: a series case on the day is followed once, and two cases never share a slot', async () => {
    const { fixture, world } = loadFixture('series-move');
    // Both series cases sit on the same day for this test; only one later slot exists.
    const second = world.cases.get('case-series-2') as CaseSnapshot;
    world.cases.set(second.caseId, { ...second, scheduledStart: '2026-12-10T11:00:00.000Z' });
    world.slots = [
      {
        slotId: 'slot-asc-20261211-0800',
        facilityId: 'asc-sunrise-foot',
        siteOfService: 'asc',
        surgeonId: 'surgeon-dpm-002',
        start: '2026-12-11T08:00:00.000Z',
        end: '2026-12-11T10:00:00.000Z',
      },
    ];
    const plan = await buildChangePlan(
      fixture.practiceId,
      { type: 'surgeon_calendar', surgeonId: 'surgeon-dpm-002', date: '2026-12-10', reason: 'Out' },
      world.planningPorts(),
      ON,
    );
    expect(plan.cases.map((c) => [c.caseId, c.newSlot?.slotId])).toEqual([
      ['case-series-1', 'slot-asc-20261211-0800'],
      ['case-series-2', undefined],
    ]);
    expect(plan.blockers).toHaveLength(1);
  });
});

describe('approval', () => {
  it('nothing is approved at build time; one scheduler approval moves it to approved', async () => {
    const { plan, world } = await sitePlan();
    expect(plan.status).toBe('proposed');
    const approved = approveChangePlan(plan, SCHEDULER, world.nowIso);
    expect(approved.status).toBe('approved');
    expect(approved.approval).toEqual({ approver: SCHEDULER, at: world.nowIso });
    expect(plan.status).toBe('proposed');
  });

  it('refuses a second approval', async () => {
    const { plan, world } = await sitePlan();
    const approved = approveChangePlan(plan, SCHEDULER, world.nowIso);
    expect(() => approveChangePlan(approved, SCHEDULER, world.nowIso)).toThrow(/already approved/);
  });

  it('a delegated policy may approve a non-cancellation plan', async () => {
    const { plan, world } = await sitePlan();
    expect(approveChangePlan(plan, POLICY, world.nowIso).status).toBe('approved');
  });

  it('a rejected plan cannot be approved or rejected again', async () => {
    const { plan, world } = await sitePlan();
    const rejected = rejectChangePlan(plan, 'user-scheduler-01', 'Patient prefers original date', world.nowIso);
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection?.reason).toBe('Patient prefers original date');
    expect(() => approveChangePlan(rejected, SCHEDULER, world.nowIso)).toThrow(/only a proposed plan/);
    expect(() => rejectChangePlan(rejected, 'u', 'r', world.nowIso)).toThrow(/only a proposed plan/);
  });
});
