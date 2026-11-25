import { describe, expect, it } from 'vitest';
import { checkAscAddOn, submitAscAddOn } from './asc-add-on.js';
import { DEFAULT_URGENT_CONFIRM_TIMEOUT_MINUTES, loadUrgentAddOnConfig } from './config.js';
import { FakeAscChannel, FakeAscDirectory, FakeOfficeSchedule } from './fakes.js';
import { urgentFixtures } from './fixtures/load.js';
import { bookOfficeRoom } from './office-room.js';
import { localDate, verifyUrgentOrder } from './verify-order.js';

const office = urgentFixtures.officeDebridement;
const asc = urgentFixtures.ascIncisionDrainage;
const now = new Date(office.now);

describe('loadUrgentAddOnConfig', () => {
  it('defaults the feature off and the timeout to 15 minutes', () => {
    expect(loadUrgentAddOnConfig({})).toEqual({ enabled: false, confirmTimeoutMinutes: 15, offeredSlotCount: 3 });
    expect(DEFAULT_URGENT_CONFIRM_TIMEOUT_MINUTES).toBe(15);
  });

  it('reads the flag and timeout and rejects invalid timeouts', () => {
    expect(loadUrgentAddOnConfig({ FEATURE_URGENT_ADD_ONS: 'true', URGENT_CONFIRM_TIMEOUT_MINUTES: '20' })).toMatchObject({
      enabled: true,
      confirmTimeoutMinutes: 20,
    });
    for (const bad of ['0', '-5', 'abc', '2.5', '']) {
      expect(loadUrgentAddOnConfig({ URGENT_CONFIRM_TIMEOUT_MINUTES: bad }).confirmTimeoutMinutes).toBe(15);
    }
    expect(loadUrgentAddOnConfig({ FEATURE_URGENT_ADD_ONS: 'yes' }).enabled).toBe(false);
  });
});

describe('verifyUrgentOrder', () => {
  it('passes a matching signed urgent order', () => {
    expect(verifyUrgentOrder(office.order, office.caseRequest, now)).toEqual([]);
  });

  it('uses the site of service local date', () => {
    // 03:30 UTC on Dec 2 is still Dec 1 in Chicago.
    expect(localDate(new Date('2026-12-02T03:30:00Z'), 'America/Chicago')).toBe('2026-12-01');
  });

  it('reports every failed check', () => {
    const issues = verifyUrgentOrder(
      { ...office.order, urgency: 'routine', signature: { signedBy: 'someone-else', signedAt: office.now }, date: '2026-11-30' },
      { ...office.caseRequest, orderId: 'order-other', side: 'bilateral', procedure: { code: '28002', description: 'I&D' } },
      now,
    );
    expect(issues.map((i) => i.code)).toEqual([
      'signed_by_other_than_surgeon',
      'order_not_urgent',
      'order_case_mismatch',
      'date_mismatch',
      'date_in_past',
      'side_mismatch',
      'procedure_mismatch',
    ]);
  });
});

describe('bookOfficeRoom', () => {
  it('rejects a non-office order', async () => {
    await expect(bookOfficeRoom(new FakeOfficeSchedule(), asc.order, now, 3)).rejects.toThrow('office site of service');
  });

  it('offers later slots, excluding those lost to a race', async () => {
    const schedule = new FakeOfficeSchedule();
    for (const { slot, bookedCaseId } of office.office?.slots ?? []) {
      schedule.addSlot(office.order.practiceId, 'loc-main', slot, bookedCaseId);
      schedule.raceTaken.add(slot.slotId);
    }
    const result = await bookOfficeRoom(schedule, office.order, now, 3);
    expect(result).toEqual({ kind: 'room_full', offeredSlots: [] });
    expect(schedule.bookCalls).toEqual(['slot-1202-0900', 'slot-1202-1000']);
  });

  it('treats an unknown slot as taken', async () => {
    const schedule = new FakeOfficeSchedule();
    expect(await schedule.bookSlot({ practiceId: 'p', slotId: 'x', caseId: 'c', patientId: 'pt', surgeonId: 's', procedureCode: '1' })).toEqual({
      ok: false,
      reason: 'slot_taken',
    });
  });
});

describe('ASC add-on', () => {
  it('rejects a non-ASC order', async () => {
    await expect(submitAscAddOn(new FakeAscDirectory(), new FakeAscChannel(), office.order, now, 15)).rejects.toThrow('ASC site');
  });

  it('falls back to a call task without a phone number when the ASC is unknown', async () => {
    const result = await submitAscAddOn(new FakeAscDirectory(), new FakeAscChannel(), asc.order, now, 15);
    expect(result).toMatchObject({ kind: 'call_task', reason: 'facility_unknown', phoneNumber: null });
  });

  it('falls back to a call task when submission fails', async () => {
    const directory = new FakeAscDirectory();
    if (asc.asc === undefined) throw new Error('fixture needs asc');
    directory.add(asc.order.practiceId, asc.asc);
    const channel = new FakeAscChannel();
    channel.failSubmit = true;
    const result = await submitAscAddOn(directory, channel, asc.order, now, 15);
    expect(result).toMatchObject({ kind: 'call_task', reason: 'submission_failed', phoneNumber: '555-0142' });
  });

  it('honors an injected timeout', async () => {
    const directory = new FakeAscDirectory();
    if (asc.asc === undefined) throw new Error('fixture needs asc');
    directory.add(asc.order.practiceId, asc.asc);
    const result = await submitAscAddOn(directory, new FakeAscChannel(), asc.order, now, 5);
    expect(result).toMatchObject({ kind: 'submitted', confirmBy: new Date(now.getTime() + 5 * 60_000) });
  });

  it('names the facility by ID when it has left the directory at timeout', async () => {
    const channel = new FakeAscChannel();
    const result = await checkAscAddOn(new FakeAscDirectory(), channel, asc.order, 'sub-x', now, now);
    expect(result).toMatchObject({ kind: 'call_task', reason: 'no_confirmation', facilityName: null, phoneNumber: null });
    if (result.kind === 'call_task') expect(result.detail).toContain('asc-synth-north');
  });
});
