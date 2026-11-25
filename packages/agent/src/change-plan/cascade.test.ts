/** Acceptance scenarios for RAH-57, run end to end against the in-memory fakes and podiatry fixtures. */
import { describe, expect, it } from 'vitest';
import { approveChangePlan, buildChangePlan, ChangePlanError } from './plan.js';
import { executeChangePlan } from './execute.js';
import type { Approver, ChangePlan, StepKind } from './model.js';
import { loadFixture } from './test-fixtures.js';

const ON = { featureEnabled: true };
const SCHEDULER: Approver = { type: 'human', userId: 'user-scheduler-01', role: 'scheduler' };
const kinds = (plan: ChangePlan, caseId?: string): StepKind[] =>
  plan.steps.filter((s) => caseId === undefined || s.caseId === caseId).map((s) => s.action.kind);

describe('Scenario 1: date move outside the auth window', () => {
  it('builds a plan with every downstream step and re-enters at Auth pending', async () => {
    const { fixture, world } = loadFixture('date-move-outside-auth');
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);

    expect(plan.status).toBe('proposed');
    expect(plan.blockers).toEqual([]);
    expect(plan.cases).toHaveLength(1);
    const effect = plan.cases[0]!;
    expect(effect.newSlot?.slotId).toBe('slot-asc-20261231-1400');
    expect(effect.authorizationResubmission).toBe(true);
    expect(effect.reentryStatus).toBe('Auth pending');
    expect(effect.expiringReadinessItemIds).toEqual(['ri-cbc-0001']);
    expect(kinds(plan)).toEqual([
      'enter_rescheduling',
      'update_facility_posting',
      'resubmit_authorization',
      'reopen_readiness_item',
      'update_coordination_request',
      'update_coordination_request',
      'move_post_op_visit',
      'notify_patient',
      'update_ehr',
      'update_practice_management',
      'release_slot_to_waitlist',
      'reenter_workflow',
    ]);
    // Building the plan wrote nothing.
    expect(world.calls).toEqual([]);
  });

  it('when approved, posts the slot, re-submits auth, reopens labs, updates rep and facility, moves post-op, notifies', async () => {
    const { fixture, world } = loadFixture('date-move-outside-auth');
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);
    const done = await executeChangePlan(approveChangePlan(plan, SCHEDULER, world.nowIso), world.executionPorts(), ON);

    expect(done.status).toBe('completed');
    expect(done.steps.every((s) => s.status === 'succeeded' && s.results.length === 1)).toBe(true);
    expect(world.writesTo('facility', 'update')[0]?.args).toMatchObject({ start: '2026-12-31T14:00:00.000Z' });
    expect(world.writesTo('authorization', 'resubmit')[0]?.args).toMatchObject({ cptCodes: ['28297'] });
    expect(world.writesTo('readiness', 'reopen').map((c) => (c.args as { itemId: string }).itemId)).toEqual(['ri-cbc-0001']);
    expect(world.writesTo('coordination', 'updateRequest').map((c) => (c.args as { requestId: string }).requestId)).toEqual([
      'coord-rep-0001',
      'coord-anes-0001',
    ]);
    expect(world.writesTo('postOp', 'move')[0]?.args).toEqual({
      appointmentId: 'appt-postop-0001',
      newStart: '2027-01-07T15:00:00.000Z',
    });
    expect(world.writesTo('messaging', 'send')[0]?.args).toMatchObject({ template: 'case_rescheduled' });
    expect(world.writesTo('ehr')).toHaveLength(1);
    expect(world.writesTo('practiceManagement')).toHaveLength(1);
    expect(world.writesTo('waitlist')[0]?.args).toMatchObject({ slotId: 'slot-asc-20261210-1400' });
    expect(world.writesTo('caseState').map((c) => (c.args as { to: string }).to)).toEqual(['Rescheduling', 'Auth pending']);
    expect(world.cases.get('case-bunion-0001')?.status).toBe('Auth pending');
    // Every write carries a plan-scoped idempotency key.
    expect(world.calls.every((c) => c.idempotencyKey.startsWith(`${plan.planId}:`))).toBe(true);
  });
});

describe('Scenario 2: surgeon out sick', () => {
  it('produces one batched plan covering all four cases and runs nothing before approval', async () => {
    const { fixture, world } = loadFixture('surgeon-out-sick');
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);

    expect(plan.cases.map((c) => c.caseId)).toEqual(['case-sick-1', 'case-sick-2', 'case-sick-3', 'case-sick-4']);
    expect(plan.cases.every((c) => c.reason === 'surgeon_calendar')).toBe(true);
    expect(plan.cases.map((c) => c.newSlot?.slotId)).toEqual([
      'slot-asc-20261209-0800',
      'slot-asc-20261209-1030',
      'slot-asc-20261209-1200',
      'slot-asc-20261209-1400',
    ]);
    // No case is put back on the sick day.
    expect(plan.cases.every((c) => !c.newSlot?.start.startsWith('2026-12-08'))).toBe(true);
    expect(plan.cases.every((c) => c.reentryStatus === 'Booked')).toBe(true);
    expect(new Set(plan.steps.map((s) => s.caseId)).size).toBe(4);
    expect(plan.approval).toBeUndefined();

    await expect(executeChangePlan(plan, world.executionPorts(), ON)).rejects.toMatchObject({ code: 'not_approved' });
    expect(world.calls).toEqual([]);

    const done = await executeChangePlan(approveChangePlan(plan, SCHEDULER, world.nowIso), world.executionPorts(), ON);
    expect(done.status).toBe('completed');
    expect(done.approval?.approver).toEqual(SCHEDULER);
    expect(world.writesTo('messaging', 'send')).toHaveLength(4);
    expect(world.writesTo('waitlist')).toHaveLength(4);
  });
});

describe('Site change', () => {
  it('posts at the new facility, cancels the old posting and re-enters at Booked when auth still covers it', async () => {
    const { fixture, world } = loadFixture('site-change');
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);

    expect(plan.cases[0]?.reentryStatus).toBe('Booked');
    expect(kinds(plan)).toEqual([
      'enter_rescheduling',
      'post_facility_slot',
      'cancel_facility_posting',
      'notify_patient',
      'update_ehr',
      'update_practice_management',
      'release_slot_to_waitlist',
      'reenter_workflow',
    ]);
    const done = await executeChangePlan(approveChangePlan(plan, SCHEDULER, world.nowIso), world.executionPorts(), ON);
    expect(done.status).toBe('completed');
    expect(world.writesTo('facility', 'post')[0]?.args).toMatchObject({ facilityId: 'asc-sunrise-foot' });
    expect(world.writesTo('facility', 'cancel')[0]?.args).toEqual({ facilityId: 'office-pr-1', slotId: 'slot-opr-20261215-0900' });
    expect(world.cases.get('case-hammertoe-0002')?.status).toBe('Booked');
  });
});

describe('Case series', () => {
  it('moving a series case proposes moving the later cases to keep spacing, approved as one plan', async () => {
    const { fixture, world } = loadFixture('series-move');
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);

    expect(plan.cases.map((c) => [c.caseId, c.reason, c.newSlot?.start])).toEqual([
      ['case-series-1', 'requested', '2026-12-17T08:00:00.000Z'],
      ['case-series-2', 'series_spacing', '2027-02-18T08:00:00.000Z'],
    ]);
    expect(plan.cases[1]?.notes[0]).toContain('moved 7 day(s)');
    const done = await executeChangePlan(approveChangePlan(plan, SCHEDULER, world.nowIso), world.executionPorts(), ON);
    expect(done.status).toBe('completed');
    expect(world.writesTo('facility', 'update').map((c) => c.caseId)).toEqual(['case-series-1', 'case-series-2']);
  });

  it('cancelling one series case never cancels the others', async () => {
    const { fixture, world } = loadFixture('cancellation');
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);

    expect(plan.requiresHumanApprover).toBe(true);
    expect(plan.cases.map((c) => c.caseId)).toEqual(['case-series-1']);
    expect(plan.steps.every((s) => s.caseId === 'case-series-1')).toBe(true);
    expect(plan.cases[0]?.notes.join(' ')).toContain('other cases in the series are not changed');
    expect(kinds(plan)).toEqual([
      'cancel_facility_posting',
      'cancel_coordination_request',
      'cancel_post_op_visit',
      'notify_patient',
      'update_ehr',
      'update_practice_management',
      'release_slot_to_waitlist',
      'reenter_workflow',
    ]);

    const done = await executeChangePlan(approveChangePlan(plan, SCHEDULER, world.nowIso), world.executionPorts(), ON);
    expect(done.status).toBe('completed');
    expect(world.cases.get('case-series-1')?.status).toBe('Cancelled');
    expect(world.cases.get('case-series-2')?.status).toBe('Booked');
    expect(world.calls.filter((c) => c.caseId === 'case-series-2')).toEqual([]);
  });

  it('a cancellation cannot be approved by a delegated policy', async () => {
    const { fixture, world } = loadFixture('cancellation');
    const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);
    expect(() => approveChangePlan(plan, { type: 'delegated_policy', policyId: 'pol-1' }, world.nowIso)).toThrow(
      ChangePlanError,
    );
    expect(() => approveChangePlan(plan, { type: 'delegated_policy', policyId: 'pol-1' }, world.nowIso)).toThrow(
      /approved by a person/,
    );
  });
});
