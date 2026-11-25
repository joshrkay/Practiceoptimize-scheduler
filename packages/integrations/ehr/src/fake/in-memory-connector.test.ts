import { describe, expect, it } from 'vitest';
import { buildFakePractice, FAKE_PRACTICE, PATIENT_ID } from '../../tests/support/fake-harness.js';

const ctx = { practiceId: FAKE_PRACTICE, locationId: 'loc-athenahealth' };

describe('InMemoryEhrConnector', () => {
  it('filters orders by receipt time', async () => {
    const { connector } = buildFakePractice();
    expect(await connector.listOrders(ctx, { since: '2027-01-02T10:00:00.000Z' })).toMatchObject({ value: [{ externalId: 'ord-1' }] });
    expect(await connector.listOrders(ctx, { since: '2027-01-03T00:00:00.000Z' })).toEqual({ status: 'ok', value: [] });
  });

  it('returns coverage primary first and not_found for unknown patients', async () => {
    const { connector } = buildFakePractice();
    const coverage = await connector.getCoverage(ctx, PATIENT_ID);
    expect(coverage.status === 'ok' && coverage.value.map((c) => c.memberId)).toEqual(['MEM-1', 'SEC-2']);
    expect(await connector.getCoverage(ctx, 'nobody')).toMatchObject({ code: 'not_found' });
    expect(await connector.listDocuments(ctx, { patientId: 'nobody' })).toMatchObject({ code: 'not_found' });
    expect(await connector.writeChartDocument(ctx, {
      patientId: 'nobody', documentType: 'Note', title: 't', contentType: 'text/plain', content: 'c',
      authoredAt: '2027-01-01T00:00:00.000Z', idempotencyKey: 'k',
    })).toMatchObject({ code: 'not_found' });
  });

  it('filters documents by date and appointments by provider', async () => {
    const { connector } = buildFakePractice();
    expect(await connector.listDocuments(ctx, { patientId: PATIENT_ID, since: '2027-01-01T00:00:00.000Z' })).toEqual({ status: 'ok', value: [] });
    const window = { from: '2027-02-01T00:00:00.000Z', to: '2027-02-08T00:00:00.000Z' };
    expect(await connector.listAppointments(ctx, { ...window, providerId: 'prov-2' })).toEqual({ status: 'ok', value: [] });
    expect(await connector.listAppointments(ctx, { ...window, providerId: 'prov-1' })).toMatchObject({ value: [{ id: 'appt-existing' }] });
  });

  it('hides booked slots and filters by visit type', async () => {
    const { connector } = buildFakePractice();
    const window = { from: '2027-02-01T00:00:00.000Z', to: '2027-02-08T00:00:00.000Z' };
    const slots = await connector.findOpenSlots(ctx, window);
    expect(slots.status === 'ok' && slots.value.map((s) => s.id)).toEqual(['slot-1', 'slot-3']);
    expect(await connector.findOpenSlots(ctx, { ...window, visitType: 'Consult' })).toEqual({ status: 'ok', value: [] });
    expect(await connector.findOpenSlots(ctx, { from: 'not-a-date', to: window.to })).toMatchObject({ code: 'invalid_request' });
  });

  it('books, then the slot disappears; unknown patients cannot be booked', async () => {
    const { connector } = buildFakePractice();
    const booked = await connector.bookAppointment(ctx, {
      patientId: PATIENT_ID, providerId: 'prov-1', visitType: 'Post-op',
      start: '2027-02-01T14:00:00.000Z', end: '2027-02-01T14:30:00.000Z', idempotencyKey: 'b1',
    });
    expect(booked).toMatchObject({ status: 'ok', value: { status: 'booked' } });
    const slots = await connector.findOpenSlots(ctx, { from: '2027-02-01T00:00:00.000Z', to: '2027-02-02T00:00:00.000Z' });
    expect(slots).toEqual({ status: 'ok', value: [] });
    expect(await connector.bookAppointment(ctx, {
      patientId: 'nobody', providerId: 'prov-1', visitType: 'Post-op',
      start: '2027-02-01T15:00:00.000Z', end: '2027-02-01T15:30:00.000Z', idempotencyKey: 'b2',
    })).toMatchObject({ code: 'not_found' });
  });

  it('records chart writes and in-basket messages per location', async () => {
    const { connector } = buildFakePractice({ athenahealth: { 'inbasket.send': 'supported' } });
    await connector.sendInBasketMessage(ctx, { recipientId: 'r', subject: 's', body: 'b', idempotencyKey: 'm1' });
    expect(connector.writes(ctx).inBasket).toHaveLength(1);
    expect(connector.writes({ practiceId: FAKE_PRACTICE, locationId: 'loc-nextgen' }).inBasket).toHaveLength(0);
  });
});
