import { describe, expect, it } from 'vitest';
import { CoordinationNotFoundError } from './coordinator.js';
import type { CoordinationRequest } from './requests.js';
import { InvalidTransitionError } from './requests.js';
import { buildHarness } from './test-harness.js';

type Harness = ReturnType<typeof buildHarness>;

async function scheduleCase(h: Harness) {
  const { practiceId, caseId } = h.fixture.case;
  return h.coordinator.onStageReached(practiceId, caseId, 'scheduled');
}

function byStep(requests: CoordinationRequest[], stepId: string): CoordinationRequest {
  const found = requests.find((request) => request.stepId === stepId);
  if (!found) throw new Error(`no request for step ${stepId}`);
  return found;
}

function messagesFor(h: Harness, requestId: string) {
  return h.sender.sent.filter((message) => message.requestId === requestId);
}

describe('CareTeamCoordinator: opening requests at a case stage', () => {
  it('opens the podiatry ASC journey steps, sending some and holding the facility posting for approval', async () => {
    const h = buildHarness();
    const result = await scheduleCase(h);
    const expected = h.fixture.expected.scheduledStage;

    expect(result.disabled).toBe(false);
    expect(result.created.map((request) => request.stepId).sort()).toEqual([...expected.steps].sort());
    expect(result.skipped).toEqual([]);

    const sentSteps = result.created.filter((request) => request.sentAt !== null).map((request) => request.stepId);
    expect(sentSteps.sort()).toEqual([...expected.sentImmediately].sort());
    expect(h.sender.sent.every((message) => message.kind === 'request')).toBe(true);

    const posting = byStep(result.created, 'facility-posting');
    expect(posting.status).toBe('open');
    expect(posting.sentAt).toBeNull();
    expect(posting.approval).toEqual({ status: 'pending', reviewItemId: 'review-1' });
    expect(h.reviewQueue.items).toEqual([{ reviewItemId: 'review-1', requestId: posting.id, withdrawn: null }]);
    expect(posting.channel).toBe('fax');
    expect(posting.dueAt).toBe('2027-01-27T00:00:00.000Z');
  });

  it('is idempotent per case, party and type', async () => {
    const h = buildHarness();
    await scheduleCase(h);
    const sentBefore = h.sender.sent.length;
    const again = await scheduleCase(h);

    expect(again.created).toEqual([]);
    expect(again.skipped.map((skip) => skip.reason)).toEqual([
      'already_requested',
      'already_requested',
      'already_requested',
      'already_requested',
    ]);
    expect(h.sender.sent.length).toBe(sentBefore);
    expect(await h.store.listActive(h.fixture.case.practiceId)).toHaveLength(4);
  });

  it('does not re-request a party that already answered for the same surgery date', async () => {
    const h = buildHarness();
    const { created } = await scheduleCase(h);
    const clearance = byStep(created, 'clearance-primary-care');
    await h.coordinator.recordAnswer(h.fixture.case.practiceId, clearance.id, 'cleared');

    const again = await scheduleCase(h);
    expect(again.created).toEqual([]);
    expect(again.skipped).toContainEqual({ stepId: 'clearance-primary-care', reason: 'already_requested' });
  });

  it('creates a resolve-contact task instead of a request when no party is on file', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    h.cases.put({ ...h.fixture.case, flags: [...h.fixture.case.flags, 'cardiac_clearance_required'] });

    const result = await h.coordinator.onStageReached(practiceId, caseId, 'scheduled');
    expect(result.skipped).toEqual([{ stepId: 'clearance-cardiology', reason: 'party_unresolved' }]);
    expect(h.tasks.tasks).toEqual([
      expect.objectContaining({ kind: 'resolve_contact', partyRole: 'cardiology', caseId }),
    ]);
  });

  it('holds a step for approval when the practice policy requires it', async () => {
    const h = buildHarness({ policyApproveFirst: ['clearance'] });
    const { created } = await scheduleCase(h);
    expect(byStep(created, 'clearance-primary-care').approval.status).toBe('pending');
    expect(byStep(created, 'vendor-rep').approval.status).toBe('not_required');
    expect(h.policy.asked.map((action) => action.requestType)).not.toContain('facility_posting');
  });

  it('does nothing while FEATURE_CARE_TEAM_COORDINATION is off', async () => {
    const h = buildHarness({ config: { enabled: false } });
    const { practiceId, caseId } = h.fixture.case;
    expect(await scheduleCase(h)).toEqual({ disabled: true, created: [], skipped: [] });
    expect(await h.coordinator.runEscalation(practiceId)).toEqual({
      disabled: true,
      reminders: 0,
      phoneTasks: 0,
      overdue: 0,
    });
    expect(
      await h.coordinator.onChangeApproved({ kind: 'cancel_case', practiceId, caseId, changePlanId: 'cp-1' }),
    ).toEqual({ disabled: true, cancelled: [], reissued: [], notified: [] });
    expect(h.sender.sent).toEqual([]);
  });

  it('fails clearly for an unknown case', async () => {
    const h = buildHarness();
    await expect(
      h.coordinator.onStageReached(h.fixture.case.practiceId, 'case-missing', 'scheduled'),
    ).rejects.toBeInstanceOf(CoordinationNotFoundError);
  });
});

describe('CareTeamCoordinator: approve-first requests', () => {
  it('sends a facility posting only after a scheduler approves it', async () => {
    const h = buildHarness();
    const { practiceId } = h.fixture.case;
    const posting = byStep((await scheduleCase(h)).created, 'facility-posting');
    expect(messagesFor(h, posting.id)).toEqual([]);

    h.clock.advanceHours(100);
    await h.coordinator.runEscalation(practiceId);
    expect(messagesFor(h, posting.id)).toEqual([]);

    const approved = await h.coordinator.approveRequest(practiceId, posting.id, 'review-1');
    expect(approved.approval).toMatchObject({ status: 'approved', via: 'review_queue', ref: 'review-1' });
    expect(approved.sentAt).toBe(h.clock.now().toISOString());
    expect(messagesFor(h, posting.id)).toEqual([expect.objectContaining({ kind: 'request', channel: 'fax' })]);
    await expect(h.coordinator.approveRequest(practiceId, posting.id, 'review-1')).rejects.toThrow(
      /not awaiting approval/,
    );
  });

  it('holds a peer-to-peer request for approval and counts its due time from the send', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    const { created } = await h.coordinator.onStageReached(practiceId, caseId, 'authorization_denied');
    const p2p = byStep(created, 'peer-to-peer');
    expect(p2p.approval.status).toBe('pending');
    expect(p2p.channel).toBe('in_basket');
    expect(h.sender.sent).toEqual([]);

    h.clock.advanceHours(5);
    const approved = await h.coordinator.approveRequest(practiceId, p2p.id, 'review-1');
    expect(approved.dueAt).toBe(new Date(h.clock.now().getTime() + 48 * 3_600_000).toISOString());
  });

  it('cancels a rejected approve-first request without sending it', async () => {
    const h = buildHarness();
    const { practiceId } = h.fixture.case;
    const { created } = await scheduleCase(h);
    const posting = byStep(created, 'facility-posting');
    const rejected = await h.coordinator.rejectRequest(practiceId, posting.id, 'wrong facility');
    expect(rejected.status).toBe('cancelled');
    expect(rejected.cancelReason).toBe('rejected in review: wrong facility');
    expect(messagesFor(h, posting.id)).toEqual([]);

    const vendor = byStep(created, 'vendor-rep');
    await expect(h.coordinator.rejectRequest(practiceId, vendor.id, 'no')).rejects.toThrow(/not awaiting approval/);
  });
});

describe('CareTeamCoordinator: reminder ladder (Scenario 1: unanswered request escalates)', () => {
  it('sends reminders at 48 and 96 hours and creates a phone task at 96 hours', async () => {
    const h = buildHarness();
    const { practiceId } = h.fixture.case;
    const clearance = byStep((await scheduleCase(h)).created, 'clearance-primary-care');

    h.clock.advanceHours(47);
    await h.coordinator.runEscalation(practiceId);
    expect(messagesFor(h, clearance.id).map((message) => message.kind)).toEqual(['request']);

    h.clock.advanceHours(1);
    await h.coordinator.runEscalation(practiceId);
    expect(messagesFor(h, clearance.id).map((message) => [message.kind, message.reminderLevel])).toEqual([
      ['request', undefined],
      ['reminder', 1],
    ]);
    expect(h.tasks.tasks.filter((task) => task.requestId === clearance.id)).toEqual([]);

    h.clock.advanceHours(48);
    await h.coordinator.runEscalation(practiceId);
    const reminders = messagesFor(h, clearance.id).filter((message) => message.kind === 'reminder');
    expect(reminders.map((message) => message.reminderLevel)).toEqual([1, 2]);
    expect(reminders.every((message) => message.channel === 'fax')).toBe(true);
    expect(h.tasks.tasks.filter((task) => task.requestId === clearance.id)).toEqual([
      expect.objectContaining({ kind: 'phone_call', partyRole: 'primary_care', practiceId }),
    ]);

    const stored = await h.store.get(practiceId, clearance.id);
    expect(stored?.remindersSent).toBe(2);
    expect(stored?.phoneTaskId).toMatch(/^task-/);
    expect(stored?.history.map((entry) => entry.event)).toEqual([
      'created',
      'sent',
      'reminder_sent',
      'reminder_sent',
      'phone_task_created',
    ]);

    h.clock.advanceHours(48);
    const later = await h.coordinator.runEscalation(practiceId);
    expect(later.reminders).toBe(0);
    expect(later.phoneTasks).toBe(0);
  });

  it('honours configured reminder hours', async () => {
    const h = buildHarness({ config: { remind1Hours: 24, remind2Hours: 72 } });
    const { practiceId } = h.fixture.case;
    const clearance = byStep((await scheduleCase(h)).created, 'clearance-primary-care');
    h.clock.advanceHours(24);
    await h.coordinator.runEscalation(practiceId);
    expect(messagesFor(h, clearance.id).filter((message) => message.kind === 'reminder')).toHaveLength(1);
  });

  it('stops escalating once the party answers', async () => {
    const h = buildHarness();
    const { practiceId } = h.fixture.case;
    const clearance = byStep((await scheduleCase(h)).created, 'clearance-primary-care');
    h.clock.advanceHours(48);
    await h.coordinator.runEscalation(practiceId);
    const answered = await h.coordinator.recordAnswer(practiceId, clearance.id, 'clearance received');
    expect(answered.status).toBe('answered');
    expect(answered.answeredAt).toBe(h.clock.now().toISOString());

    h.clock.advanceHours(48);
    await h.coordinator.runEscalation(practiceId);
    expect(messagesFor(h, clearance.id).filter((message) => message.kind === 'reminder')).toHaveLength(1);
    expect(h.tasks.tasks.filter((task) => task.requestId === clearance.id)).toEqual([]);
    await expect(h.coordinator.recordAnswer(practiceId, clearance.id)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('marks a blocking request overdue at its due date, raises case risk, and clears it on answer', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    const clearance = byStep((await scheduleCase(h)).created, 'clearance-primary-care');

    h.clock.advanceHours(40 * 24);
    const result = await h.coordinator.runEscalation(practiceId);
    // Vendor rep, anesthesia packet and clearance; the unapproved facility posting was never sent.
    expect(result.overdue).toBe(3);
    expect((await h.store.get(practiceId, clearance.id))?.status).toBe('overdue');
    expect(h.risk.raised).toContainEqual({ caseId, requestId: clearance.id });

    const again = await h.coordinator.runEscalation(practiceId);
    expect(again.overdue).toBe(0);

    await h.coordinator.recordAnswer(practiceId, clearance.id);
    expect(h.risk.cleared).toEqual([{ caseId, requestId: clearance.id }]);
  });

  it('does not raise case risk for a non-blocking request', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    h.cases.put({ ...h.fixture.case, flags: ['post_op_service'] });
    h.directory.put(practiceId, caseId, { partyId: 'party-pt', role: 'post_op_service', preferredChannel: 'fax' });
    await h.coordinator.onStageReached(practiceId, caseId, 'post_op');
    h.clock.advanceHours(73);
    const result = await h.coordinator.runEscalation(practiceId);
    expect(result.overdue).toBe(1);
    expect(h.risk.raised).toEqual([]);
  });

  it('keeps practices isolated', async () => {
    const h = buildHarness();
    await scheduleCase(h);
    h.clock.advanceHours(96);
    const other = await h.coordinator.runEscalation(h.fixture.otherPracticeId);
    expect(other).toEqual({ disabled: false, reminders: 0, phoneTasks: 0, overdue: 0 });
    const posting = (await h.store.listActive(h.fixture.case.practiceId))[0];
    await expect(
      h.coordinator.recordAnswer(h.fixture.otherPracticeId, posting?.id ?? ''),
    ).rejects.toBeInstanceOf(CoordinationNotFoundError);
  });
});

describe('CareTeamCoordinator: approved changes (Scenario 2: change re-runs requests)', () => {
  it('cancels open facility and vendor rep requests and sends updated requests for the new date', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    const newDate = h.fixture.expected.newSurgeryDate;
    const { created } = await scheduleCase(h);
    const posting = byStep(created, 'facility-posting');
    const vendor = byStep(created, 'vendor-rep');
    await h.coordinator.approveRequest(practiceId, posting.id, 'review-1');
    h.clock.advanceHours(24);

    const result = await h.coordinator.onChangeApproved({
      kind: 'reschedule',
      practiceId,
      caseId,
      changePlanId: 'cp-7',
      newSurgeryDate: newDate,
    });

    for (const old of [posting, vendor]) {
      const stored = await h.store.get(practiceId, old.id);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.cancelReason).toBe('change plan cp-7');
    }
    expect(result.cancelled.map((request) => request.id)).toEqual(expect.arrayContaining([posting.id, vendor.id]));

    for (const old of [posting, vendor]) {
      const replacement = result.reissued.find((request) => request.supersedesId === old.id);
      expect(replacement).toMatchObject({
        status: 'open',
        partyId: old.partyId,
        type: old.type,
        surgeryDate: newDate,
        approval: { status: 'approved', via: 'change_plan', ref: 'cp-7' },
      });
      expect(replacement?.sentAt).toBe(h.clock.now().toISOString());
      expect(messagesFor(h, replacement?.id ?? '')).toEqual([
        expect.objectContaining({
          kind: 'updated_request',
          surgeryDate: newDate,
          supersedesRequestId: old.id,
          partyId: old.partyId,
        }),
      ]);
    }
    expect(byStep(result.reissued, 'facility-posting').dueAt).toBe('2027-02-10T00:00:00.000Z');
    expect(result.notified).toEqual([]);

    const active = await h.store.listActive(practiceId);
    expect(active.every((request) => request.surgeryDate === newDate)).toBe(true);
    expect(active).toHaveLength(4);
  });

  it('is a no-op when the change does not move the date again', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    await scheduleCase(h);
    const change = { kind: 'reschedule' as const, practiceId, caseId, changePlanId: 'cp-1', newSurgeryDate: '2027-02-24' };
    await h.coordinator.onChangeApproved(change);
    const sent = h.sender.sent.length;
    const second = await h.coordinator.onChangeApproved({ ...change, changePlanId: 'cp-2' });
    expect(second.cancelled).toEqual([]);
    expect(second.reissued).toEqual([]);
    expect(h.sender.sent.length).toBe(sent);
  });

  it('re-runs a party that already answered for the old date', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    const vendor = byStep((await scheduleCase(h)).created, 'vendor-rep');
    await h.coordinator.recordAnswer(practiceId, vendor.id, 'tray confirmed');

    const result = await h.coordinator.onChangeApproved({
      kind: 'reschedule',
      practiceId,
      caseId,
      changePlanId: 'cp-3',
      newSurgeryDate: '2027-02-24',
    });
    expect((await h.store.get(practiceId, vendor.id))?.status).toBe('answered');
    expect(result.reissued.find((request) => request.supersedesId === vendor.id)).toBeDefined();
  });

  it('withdraws a pending approval and leaves non-date-sensitive requests alone', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    const posting = byStep((await scheduleCase(h)).created, 'facility-posting');
    const p2p = byStep((await h.coordinator.onStageReached(practiceId, caseId, 'authorization_denied')).created, 'peer-to-peer');

    const result = await h.coordinator.onChangeApproved({
      kind: 'reschedule',
      practiceId,
      caseId,
      changePlanId: 'cp-4',
      newSurgeryDate: '2027-02-24',
    });
    expect(h.reviewQueue.items.find((item) => item.requestId === posting.id)?.withdrawn).toBe('change plan cp-4');
    expect(messagesFor(h, posting.id)).toEqual([]);
    expect(result.cancelled.map((request) => request.id)).not.toContain(p2p.id);
    expect((await h.store.get(practiceId, p2p.id))?.status).toBe('open');
  });

  it('sends a cancellation notice when a step no longer applies after the change', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    const { created } = await scheduleCase(h);
    const vendor = byStep(created, 'vendor-rep');
    const clearance = byStep(created, 'clearance-primary-care');
    await h.coordinator.recordAnswer(practiceId, clearance.id);
    h.cases.put({ ...h.fixture.case, flags: [] });

    const result = await h.coordinator.onChangeApproved({
      kind: 'reschedule',
      practiceId,
      caseId,
      changePlanId: 'cp-5',
      newSurgeryDate: '2027-02-24',
    });
    expect(result.reissued.map((request) => request.stepId).sort()).toEqual(['anesthesia-packet', 'facility-posting']);
    expect(result.notified.map((request) => request.id).sort()).toEqual([clearance.id, vendor.id].sort());
    expect(messagesFor(h, vendor.id).map((message) => message.kind)).toEqual(['request', 'cancellation_notice']);
    expect(messagesFor(h, clearance.id).map((message) => message.kind)).toEqual(['request', 'cancellation_notice']);
  });

  it('cancels every open request and notifies contacted parties when the case is cancelled', async () => {
    const h = buildHarness();
    const { practiceId, caseId } = h.fixture.case;
    const { created } = await scheduleCase(h);
    const posting = byStep(created, 'facility-posting');
    const clearance = byStep(created, 'clearance-primary-care');
    h.clock.advanceHours(30 * 24);
    await h.coordinator.runEscalation(practiceId);

    const result = await h.coordinator.onChangeApproved({ kind: 'cancel_case', practiceId, caseId, changePlanId: 'cp-6' });
    expect(result.cancelled).toHaveLength(4);
    expect(result.reissued).toEqual([]);
    expect(result.notified.map((request) => request.stepId).sort()).toEqual([
      'anesthesia-packet',
      'clearance-primary-care',
      'vendor-rep',
    ]);
    expect(messagesFor(h, posting.id)).toEqual([]);
    expect(h.risk.cleared).toContainEqual({ caseId, requestId: clearance.id });
    expect(await h.store.listActive(practiceId)).toEqual([]);
  });
});
