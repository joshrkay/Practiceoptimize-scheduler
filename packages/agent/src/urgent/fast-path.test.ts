import { describe, expect, it } from 'vitest';
import { loadUrgentAddOnConfig, type UrgentAddOnConfig } from './config.js';
import { bookUrgentAddOn, checkAscConfirmation, onSurgeryCompleted, type UrgentAddOnInput } from './fast-path.js';
import { loadUrgentFixture, urgentFixtures, type UrgentFixture } from './fixtures/load.js';
import type { FakeUrgentAddOnDeps } from './fakes.js';

const config: UrgentAddOnConfig = loadUrgentAddOnConfig({ FEATURE_URGENT_ADD_ONS: 'true' });

function inputOf(fixture: UrgentFixture): UrgentAddOnInput {
  return { practiceId: fixture.order.practiceId, caseId: fixture.order.caseId, orderId: fixture.order.orderId };
}

/** Appointments held by cases other than the urgent one. */
function existingAppointments(deps: FakeUrgentAddOnDeps, urgentCaseId: string): string[] {
  return deps.officeSchedule.entries
    .filter((e) => e.bookedCaseId !== null && e.bookedCaseId !== urgentCaseId)
    .map((e) => `${e.slot.slotId}:${e.bookedCaseId}:${e.appointmentId}`);
}

describe('Scenario 1: office urgent add-on', () => {
  const fixture = urgentFixtures.officeDebridement;

  it('books the next open procedure room slot within a minute and notifies the scheduler and patient', async () => {
    const deps = loadUrgentFixture(fixture);
    const before = existingAppointments(deps, fixture.order.caseId);
    const started = deps.clock.now();

    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));

    expect(result.status).toBe('booked');
    if (result.status !== 'booked') return;
    expect(deps.clock.now().getTime() - started.getTime()).toBeLessThan(60_000);
    expect(result.record.booking).toMatchObject({ where: 'office_room', start: '2026-12-02T15:00:00.000Z', postOpAppointmentId: 'postop-1' });
    // The existing case keeps its slot; only the first open slot was tried.
    expect(existingAppointments(deps, fixture.order.caseId)).toEqual(before);
    expect(deps.officeSchedule.bookCalls).toEqual(['slot-1202-0900']);

    // Ordered -> Booked with no readiness gate; billable once booked.
    expect(deps.caseState.transitions).toEqual([
      expect.objectContaining({ from: 'ordered', to: 'booked', readinessGate: 'bypassed_urgent_add_on' }),
    ]);
    expect(deps.caseState.isBillable(fixture.order.practiceId, fixture.order.caseId)).toBe(true);

    // The scheduler is notified, not asked.
    expect(deps.scheduler.notices).toEqual([
      expect.objectContaining({ kind: 'urgent_add_on_booked', responseRequired: false }),
    ]);
    // Patient and authorized contact get the compressed urgent journey.
    expect(deps.messaging.sent.map((m) => [m.recipientId, m.journey])).toEqual([
      ['patient-synth-0001', 'urgent_compressed'],
      ['contact-synth-0001', 'urgent_compressed'],
    ]);
    expect(deps.postOp.requests).toHaveLength(1);
    expect(deps.today.items).toEqual([]);
    expect(deps.policy.requests[0]?.approval).toEqual({
      kind: 'signed_urgent_order',
      orderId: 'order-urg-0001',
      signedBy: 'surgeon-dpm-01',
    });
    expect(deps.audit.events.map((e) => e.action)).toEqual(['urgent_add_on.booked']);
  });

  it('opens a retro-authorization item after surgery, due by the payer deadline, approve-first by the auth specialist', async () => {
    const deps = loadUrgentFixture(fixture);
    await bookUrgentAddOn(deps, config, inputOf(fixture));

    const completedAt = new Date('2026-12-02T16:00:00.000Z');
    const result = await onSurgeryCompleted(deps, { ...inputOf(fixture), completedAt });

    expect(result).toEqual({ status: 'opened', itemId: 'retro-1', dueBy: '2026-12-04T16:00:00.000Z' });
    expect(deps.authorization.opened).toEqual([
      expect.objectContaining({
        payerId: 'payer-synth-commercial',
        procedureCode: '11042',
        approvalMode: 'approve_first',
        assigneeRole: 'auth_specialist',
        dueBy: new Date('2026-12-04T16:00:00.000Z'),
      }),
    ]);
    // Opening twice is a no-op.
    const again = await onSurgeryCompleted(deps, { ...inputOf(fixture), completedAt });
    expect(again.status).toBe('already_opened');
    expect(deps.authorization.opened).toHaveLength(1);
  });

  it('opens the retro-authorization item with no due date when the payer rule is unknown', async () => {
    const deps = loadUrgentFixture(fixture);
    deps.authorization.windowsHours.clear();
    await bookUrgentAddOn(deps, config, inputOf(fixture));
    const result = await onSurgeryCompleted(deps, { ...inputOf(fixture), completedAt: new Date('2026-12-02T16:00:00Z') });
    expect(result).toEqual({ status: 'opened', itemId: 'retro-1', dueBy: null });
  });

  it('does not open retro-authorization for a case that was never booked', async () => {
    const deps = loadUrgentFixture(fixture);
    const result = await onSurgeryCompleted(deps, { ...inputOf(fixture), completedAt: new Date() });
    expect(result).toEqual({ status: 'not_booked', record: null });
    expect(deps.authorization.opened).toEqual([]);
  });

  it('never books twice for the same case', async () => {
    const deps = loadUrgentFixture(fixture);
    await bookUrgentAddOn(deps, config, inputOf(fixture));
    const again = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(again.status).toBe('already_handled');
    expect(deps.officeSchedule.bookCalls).toHaveLength(1);
  });

  it('skips a slot taken in a race and books the next open one', async () => {
    const deps = loadUrgentFixture(fixture);
    deps.officeSchedule.raceTaken.add('slot-1202-0900');
    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(result.status).toBe('booked');
    if (result.status === 'booked') expect(result.record.booking?.start).toBe('2026-12-02T16:00:00.000Z');
    expect(deps.officeSchedule.bookCalls).toEqual(['slot-1202-0900', 'slot-1202-1000']);
  });

  it('creates a post-op Today item when no post-op visit can be booked', async () => {
    const deps = loadUrgentFixture(fixture);
    deps.postOp.available = false;
    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(result.status).toBe('booked');
    expect(deps.today.items).toEqual([
      expect.objectContaining({ kind: 'post_op_visit_needed', priority: 'normal', pinned: false }),
    ]);
  });

  it('does nothing while FEATURE_URGENT_ADD_ONS is off', async () => {
    const deps = loadUrgentFixture(fixture);
    const result = await bookUrgentAddOn(deps, loadUrgentAddOnConfig({}), inputOf(fixture));
    expect(result).toEqual({ status: 'feature_disabled' });
    expect(deps.officeSchedule.bookCalls).toEqual([]);
    expect(deps.today.items).toEqual([]);
  });
});

describe('Scenario 2: procedure room full', () => {
  const fixture = urgentFixtures.officeRoomFull;

  it('bumps no case, offers the next open slots and creates a pinned urgent Today item', async () => {
    const deps = loadUrgentFixture(fixture);
    const before = deps.officeSchedule.entries.map((e) => `${e.slot.slotId}:${e.bookedCaseId}:${e.appointmentId}`);

    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));

    expect(result.status).toBe('room_full');
    if (result.status !== 'room_full') return;
    expect(result.offeredSlots.map((s) => s.slotId)).toEqual(['slot-1203-0800', 'slot-1203-0900', 'slot-1203-1300']);
    // Nothing on the schedule changed: no case moved, cancelled or booked.
    expect(deps.officeSchedule.entries.map((e) => `${e.slot.slotId}:${e.bookedCaseId}:${e.appointmentId}`)).toEqual(before);
    expect(deps.officeSchedule.bookCalls).toEqual([]);
    expect(deps.today.items).toEqual([
      expect.objectContaining({
        itemId: result.todayItemId,
        kind: 'urgent_room_full',
        priority: 'urgent',
        pinned: true,
        offeredSlots: result.offeredSlots,
      }),
    ]);
    expect(deps.caseState.transitions).toEqual([]);
    expect(deps.scheduler.notices).toEqual([]);
    expect((await deps.store.get(fixture.order.practiceId, fixture.order.caseId))?.status).toBe('room_full');
  });

  it('says so when there are no open slots at all', async () => {
    const deps = loadUrgentFixture(fixture);
    for (const entry of deps.officeSchedule.entries) entry.bookedCaseId ??= 'case-routine-other';
    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(result.status).toBe('room_full');
    if (result.status === 'room_full') expect(result.offeredSlots).toEqual([]);
    expect(deps.today.items[0]?.detail).toContain('none found after it');
  });
});

describe('Scenario 3: ASC add-on', () => {
  it('books through the electronic channel once the ASC confirms', async () => {
    const fixture = urgentFixtures.ascIncisionDrainage;
    const deps = loadUrgentFixture(fixture);

    const submitted = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(submitted).toEqual({ status: 'awaiting_asc_confirmation', submissionId: 'sub-1', confirmBy: '2026-12-01T16:15:00.000Z' });
    expect(deps.ascChannel.submissions[0]).toMatchObject({ facilityId: 'asc-synth-north', side: 'left', date: '2026-12-02' });
    expect(deps.caseState.transitions).toEqual([]);

    deps.clock.advanceMinutes(3);
    expect((await checkAscConfirmation(deps, inputOf(fixture))).status).toBe('awaiting_asc_confirmation');

    const confirmation = fixture.ascConfirmation;
    if (confirmation === undefined) throw new Error('fixture needs ascConfirmation');
    deps.clock.advanceMinutes(confirmation.afterMinutes - 3);
    deps.ascChannel.setStatus(fixture.order.practiceId, 'sub-1', {
      status: 'confirmed',
      start: confirmation.start,
      confirmationNumber: confirmation.confirmationNumber,
    });
    const booked = await checkAscConfirmation(deps, inputOf(fixture));
    expect(booked.status).toBe('booked');
    if (booked.status === 'booked') {
      expect(booked.record.booking).toMatchObject({ where: 'asc', reference: 'ASC-CONF-7781', start: '2026-12-02T13:30:00.000Z' });
    }
    // Mixed self-pay/insurance case is not held by a deposit gate: booked and billable.
    expect(deps.caseState.isBillable(fixture.order.practiceId, fixture.order.caseId)).toBe(true);
    expect(deps.scheduler.notices).toHaveLength(1);
    expect(deps.messaging.sent).toHaveLength(2);
    expect(deps.today.items).toEqual([]);

    const retro = await onSurgeryCompleted(deps, { ...inputOf(fixture), completedAt: new Date('2026-12-02T15:00:00Z') });
    expect(retro.status).toBe('opened');
  });

  it('creates an urgent call task with the ASC phone number when 15 minutes pass with no confirmation, with no paging', async () => {
    const fixture = urgentFixtures.ascNoConfirmation;
    const deps = loadUrgentFixture(fixture);

    const submitted = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(submitted.status).toBe('awaiting_asc_confirmation');

    deps.clock.advanceMinutes(14);
    expect((await checkAscConfirmation(deps, inputOf(fixture))).status).toBe('awaiting_asc_confirmation');
    expect(deps.today.items).toEqual([]);

    deps.clock.advanceMinutes(1);
    const result = await checkAscConfirmation(deps, inputOf(fixture));
    expect(result).toEqual({ status: 'asc_call_task', todayItemId: 'today-1', phoneNumber: '555-0187', reason: 'no_confirmation' });
    expect(deps.today.items).toEqual([
      expect.objectContaining({
        kind: 'urgent_asc_call',
        priority: 'urgent',
        pinned: true,
        assigneeRole: 'scheduler',
        phoneNumber: '555-0187',
      }),
    ]);
    // After hours: the only escalation is the Today item; no scheduler notice, nothing booked.
    expect(deps.scheduler.notices).toEqual([]);
    expect(deps.caseState.transitions).toEqual([]);

    // Re-checking does not create a second call task.
    deps.clock.advanceMinutes(30);
    expect((await checkAscConfirmation(deps, inputOf(fixture))).status).toBe('not_pending');
    expect(deps.today.items).toHaveLength(1);
  });

  it('still completes the booking when the ASC confirms after the call task was created', async () => {
    const fixture = urgentFixtures.ascNoConfirmation;
    const deps = loadUrgentFixture(fixture);
    await bookUrgentAddOn(deps, config, inputOf(fixture));
    deps.clock.advanceMinutes(16);
    await checkAscConfirmation(deps, inputOf(fixture));
    deps.ascChannel.setStatus(fixture.order.practiceId, 'sub-1', {
      status: 'confirmed',
      start: '2026-12-02T15:00:00.000Z',
      confirmationNumber: 'ASC-LATE-1',
    });
    const result = await checkAscConfirmation(deps, inputOf(fixture));
    expect(result.status).toBe('booked');
    if (result.status === 'booked') expect(result.record.todayItemIds).toEqual(['today-1']);

    // Self-pay: no retro-authorization needed.
    const retro = await onSurgeryCompleted(deps, { ...inputOf(fixture), completedAt: new Date('2026-12-02T16:00:00Z') });
    expect(retro).toEqual({ status: 'not_required' });
    expect(deps.authorization.opened).toEqual([]);
  });

  it('creates a call task right away when the ASC has no electronic channel', async () => {
    const fixture = urgentFixtures.ascIncisionDrainage;
    const deps = loadUrgentFixture(fixture);
    if (fixture.asc === undefined) throw new Error('fixture needs asc');
    deps.ascDirectory.add(fixture.order.practiceId, { ...fixture.asc, hasElectronicChannel: false });
    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(result).toEqual({ status: 'asc_call_task', todayItemId: 'today-1', phoneNumber: '555-0142', reason: 'no_electronic_channel' });
    expect(deps.ascChannel.submissions).toEqual([]);
  });

  it('creates a call task when the ASC rejects the add-on', async () => {
    const fixture = urgentFixtures.ascIncisionDrainage;
    const deps = loadUrgentFixture(fixture);
    await bookUrgentAddOn(deps, config, inputOf(fixture));
    deps.ascChannel.setStatus(fixture.order.practiceId, 'sub-1', { status: 'rejected', reason: 'No anesthesia coverage' });
    const result = await checkAscConfirmation(deps, inputOf(fixture));
    expect(result).toMatchObject({ status: 'asc_call_task', reason: 'rejected', phoneNumber: '555-0142' });
    expect(deps.today.items[0]?.detail).toContain('No anesthesia coverage');
  });

  it('reports nothing pending for an unknown case', async () => {
    const deps = loadUrgentFixture(urgentFixtures.ascIncisionDrainage);
    expect(await checkAscConfirmation(deps, { practiceId: 'practice-podiatry-pilot', caseId: 'nope' })).toEqual({
      status: 'not_pending',
      record: null,
    });
  });
});

describe('date, side and procedure checks', () => {
  const fixture = urgentFixtures.officeDebridement;

  it.each([
    ['side', { side: 'left' as const }, 'side_mismatch'],
    ['date', { date: '2026-12-03' }, 'date_mismatch'],
    ['procedure', { procedure: { code: '11043', description: 'Debridement, muscle and/or fascia' } }, 'procedure_mismatch'],
  ])('blocks and escalates on a %s mismatch without booking', async (_label, change, code) => {
    const deps = loadUrgentFixture(fixture);
    deps.intake.addCaseRequest({ ...fixture.caseRequest, ...change });

    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') return;
    expect(result.issues.map((i) => i.code)).toEqual([code]);
    expect(deps.officeSchedule.bookCalls).toEqual([]);
    expect(deps.ascChannel.submissions).toEqual([]);
    expect(deps.policy.requests).toEqual([]);
    expect(deps.caseState.transitions).toEqual([]);
    expect(deps.today.items).toEqual([
      expect.objectContaining({ itemId: result.escalationItemId, kind: 'urgent_order_blocked', priority: 'urgent', pinned: true }),
    ]);
    expect(deps.audit.events).toEqual([
      expect.objectContaining({ action: 'urgent_add_on.blocked', detail: expect.objectContaining({ issues: code }) }),
    ]);
  });

  it('blocks an unsigned order', async () => {
    const deps = loadUrgentFixture(fixture);
    deps.intake.addOrder({ ...fixture.order, signature: null });
    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(result.status).toBe('blocked');
    expect(deps.officeSchedule.bookCalls).toEqual([]);
  });

  it('blocks when the order or case cannot be found', async () => {
    const deps = loadUrgentFixture(fixture);
    const missingOrder = await bookUrgentAddOn(deps, config, { ...inputOf(fixture), orderId: 'order-missing' });
    expect(missingOrder).toMatchObject({ status: 'blocked', issues: [{ code: 'order_not_found' }] });

    const deps2 = loadUrgentFixture(fixture);
    deps2.intake.requests.clear();
    const missingCase = await bookUrgentAddOn(deps2, config, inputOf(fixture));
    expect(missingCase).toMatchObject({ status: 'blocked', issues: [{ code: 'case_request_not_found' }] });
  });

  it('blocks a case that is no longer Ordered', async () => {
    const deps = loadUrgentFixture(fixture);
    deps.caseState.set(fixture.order.practiceId, fixture.order.caseId, 'booked');
    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(result).toMatchObject({ status: 'blocked', issues: [{ code: 'case_not_ordered' }] });

    const deps2 = loadUrgentFixture(fixture);
    deps2.caseState.states.clear();
    const unknown = await bookUrgentAddOn(deps2, config, inputOf(fixture));
    expect(unknown).toMatchObject({ status: 'blocked', issues: [{ code: 'case_not_ordered' }] });
  });

  it('blocks when the policy engine blocks', async () => {
    const deps = loadUrgentFixture(fixture);
    deps.policy.decision = { outcome: 'block', reason: 'practice has urgent add-ons turned off' };
    const result = await bookUrgentAddOn(deps, config, inputOf(fixture));
    expect(result).toMatchObject({ status: 'blocked', issues: [{ code: 'policy_block' }] });
    expect(deps.officeSchedule.bookCalls).toEqual([]);
  });

  it('keeps practices isolated', async () => {
    const deps = loadUrgentFixture(fixture);
    const result = await bookUrgentAddOn(deps, config, { ...inputOf(fixture), practiceId: 'practice-other' });
    expect(result).toMatchObject({ status: 'blocked', issues: [{ code: 'order_not_found' }] });
    expect(deps.officeSchedule.bookCalls).toEqual([]);
  });
});
