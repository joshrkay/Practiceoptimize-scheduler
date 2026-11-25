import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeFaxProvider } from '@scheduler/integrations-fax';
import {
  FakeAuditSink,
  FakeEmailProvider,
  FakeInBasketProvider,
  FakeSchedulerTasks,
  InMemoryDirectoryStore,
  hashAddress,
  sendCareTeamRequest,
  verifyEndpoint,
  filterFields,
  type Party,
  type SendDeps,
} from './index';

const fixture = JSON.parse(
  readFileSync(new URL('../../../../tests/fixtures/coordination/directory.json', import.meta.url), 'utf8'),
) as { practiceId: string; parties: Party[] };
const practiceId = fixture.practiceId;

function setup() {
  const store = new InMemoryDirectoryStore(fixture.parties);
  const fax = new FakeFaxProvider();
  const email = new FakeEmailProvider();
  const inBasket = new FakeInBasketProvider();
  const audit = new FakeAuditSink();
  const tasks = new FakeSchedulerTasks();
  const deps: SendDeps = {
    store,
    fax,
    email,
    inBasket,
    audit,
    tasks,
    sender: { name: 'Synthetic Foot and Ankle Clinic', callback: '+1-555-0100' },
    now: () => new Date('2026-11-25T12:00:00.000Z'),
    newReferenceCode: () => 'REF-TEST0001',
  };
  return { store, fax, email, inBasket, audit, tasks, deps };
}

const clearanceFields = {
  patientName: 'Test Patient',
  dateOfBirth: '1970-01-01',
  procedure: 'Bunionectomy',
  surgeryDate: '2026-12-10',
  ssn: '000-00-0000',
  insuranceMemberId: 'ZZZ',
};

describe('sendCareTeamRequest', () => {
  it('faxes a cardiology clearance request with a cover sheet to the verified number and audits it', async () => {
    const { deps, fax, audit } = setup();
    const result = await sendCareTeamRequest(deps, {
      practiceId,
      partyId: 'party-cardiology',
      requestType: 'clearance_request',
      fields: clearanceFields,
    });
    expect(result).toMatchObject({ status: 'sent', channel: 'fax', referenceCode: 'REF-TEST0001', deliveryStatus: 'queued' });
    expect(fax.sent).toHaveLength(1);
    const msg = fax.sent[0]!;
    expect(msg.to).toBe('+1-555-0102');
    expect(msg.coverSheet).toContain('CONFIDENTIAL');
    expect(msg.coverSheet).toContain('REF-TEST0001');
    expect(msg.coverSheet).not.toContain('Test Patient');
    expect(msg.body).toContain('patientName: Test Patient');
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      channel: 'fax',
      outcome: 'sent',
      deliveryStatus: 'queued',
      addressHash: hashAddress(practiceId, '+1-555-0102'),
    });
    expect(JSON.stringify(audit.events)).not.toContain('555-0102');
    expect(JSON.stringify(audit.events)).not.toContain('Test Patient');
  });

  it('applies the per-request-type allowlist', async () => {
    const { deps, fax, audit } = setup();
    const result = await sendCareTeamRequest(deps, {
      practiceId,
      partyId: 'party-cardiology',
      requestType: 'clearance_request',
      fields: clearanceFields,
    });
    expect(result).toMatchObject({ droppedFields: ['ssn', 'insuranceMemberId'] });
    expect(fax.sent[0]!.body).not.toContain('000-00-0000');
    expect(fax.sent[0]!.body).not.toContain('ZZZ');
    expect(audit.events[0]!.fieldsSent).toEqual(['patientName', 'dateOfBirth', 'procedure', 'surgeryDate']);
    expect(filterFields('vendor_case_notice', { patientName: 'x', procedure: 'y' }).allowed).toEqual({ procedure: 'y' });
  });

  it('refuses an unverified PCP fax, sends nothing, and creates a verify-contact task', async () => {
    const { deps, fax, email, audit, tasks } = setup();
    const result = await sendCareTeamRequest(deps, {
      practiceId,
      partyId: 'party-pcp-new',
      requestType: 'clearance_request',
      fields: clearanceFields,
    });
    expect(result).toMatchObject({ status: 'needs_verification', channel: 'fax', taskId: 'task-1' });
    expect(fax.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(tasks.tasks[0]).toMatchObject({ kind: 'verify_contact', partyId: 'party-pcp-new', practiceId });
    expect(audit.events[0]).toMatchObject({ outcome: 'needs_verification', deliveryStatus: null, fieldsSent: [] });
  });

  it('treats a missing preferred-channel address as needing verification', async () => {
    const { deps, store, tasks, audit } = setup();
    const base = fixture.parties.find((p) => p.id === 'party-lab')!;
    await store.put({ ...base, id: 'party-lab-empty', endpoints: {} });
    const result = await sendCareTeamRequest(deps, {
      practiceId,
      partyId: 'party-lab-empty',
      requestType: 'lab_order',
      fields: {},
    });
    expect(result.status).toBe('needs_verification');
    expect(tasks.tasks[0]!.reason).toContain('no address');
    expect(audit.events[0]!.addressHash).toBeNull();
  });

  it('sends after the entry is verified', async () => {
    const { deps, store, fax } = setup();
    await verifyEndpoint(store, {
      practiceId,
      partyId: 'party-pcp-new',
      channel: 'fax',
      address: '+1-555-0101',
      verifiedBy: 'scheduler-1',
      verifiedAt: new Date('2026-11-25T11:00:00.000Z'),
    });
    const result = await sendCareTeamRequest(deps, {
      practiceId,
      partyId: 'party-pcp-new',
      requestType: 'clearance_request',
      fields: clearanceFields,
    });
    expect(result.status).toBe('sent');
    expect(fax.sent).toHaveLength(1);
  });

  it('emails with the reference code and no PHI in the subject', async () => {
    const { deps, email } = setup();
    const result = await sendCareTeamRequest(deps, {
      practiceId,
      partyId: 'party-vendor-rep',
      requestType: 'vendor_case_notice',
      fields: { procedure: 'Bunionectomy', patientName: 'Test Patient' },
    });
    expect(result).toMatchObject({ status: 'sent', channel: 'email', droppedFields: ['patientName'] });
    expect(email.sent[0]!.to).toBe('rep@vendor.example.test');
    expect(email.sent[0]!.subject).toBe('Upcoming case notice [REF-TEST0001]');
    expect(email.sent[0]!.body).toContain('CONFIDENTIAL');
    expect(email.sent[0]!.body).not.toContain('Test Patient');
  });

  it('routes through the in-basket port for a shared facility entry', async () => {
    const { deps, inBasket } = setup();
    const result = await sendCareTeamRequest(deps, {
      practiceId,
      partyId: 'party-asc-pat',
      requestType: 'pre_admission_testing_request',
      fields: { patientName: 'Test Patient', procedure: 'Bunionectomy' },
    });
    expect(result).toMatchObject({ status: 'sent', channel: 'in_basket' });
    expect(inBasket.sent[0]!.to).toBe('pat-pool');
  });

  it('returns party_not_found for another practice’s party and for unknown ids', async () => {
    const { deps, store } = setup();
    await store.put({ ...fixture.parties.find((p) => p.id === 'party-lab')!, id: 'party-other', practiceId: 'practice-other' });
    for (const partyId of ['party-other', 'nope']) {
      expect(
        await sendCareTeamRequest(deps, { practiceId, partyId, requestType: 'lab_order', fields: {} }),
      ).toEqual({ status: 'party_not_found' });
    }
  });

  it('records a failed delivery when the provider throws', async () => {
    const { deps, fax, audit } = setup();
    fax.failWith = new Error('line busy');
    const result = await sendCareTeamRequest(deps, {
      practiceId,
      partyId: 'party-lab',
      requestType: 'lab_order',
      fields: {},
    });
    expect(result).toMatchObject({ status: 'failed', channel: 'fax' });
    expect(audit.events[0]).toMatchObject({ outcome: 'failed', deliveryStatus: 'failed' });
  });

  it('uses a generated reference code by default', async () => {
    const { deps, fax } = setup();
    const { newReferenceCode: _unused, now: _n, ...rest } = deps;
    void _unused;
    void _n;
    await sendCareTeamRequest(rest, { practiceId, partyId: 'party-lab', requestType: 'lab_order', fields: {} });
    expect(fax.sent[0]!.referenceCode).toMatch(/^REF-[0-9A-F]{8}$/);
  });
});

describe('InMemoryDirectoryStore', () => {
  it('lists own and shared parties only and protects ownership', async () => {
    const { store } = setup();
    await store.put({ ...fixture.parties[0]!, id: 'party-other', practiceId: 'practice-other' });
    const ids = (await store.list(practiceId)).map((p) => p.id);
    expect(ids).toContain('party-asc-desk');
    expect(ids).not.toContain('party-other');
    await expect(store.put({ ...fixture.parties[0]!, practiceId: 'practice-other' })).rejects.toThrow();
    await expect(
      verifyEndpoint(store, {
        practiceId,
        partyId: 'missing',
        channel: 'fax',
        address: 'x',
        verifiedBy: 'a',
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow('party not found');
  });

  it('covers the podiatry fixture roles', () => {
    const kinds = new Set(fixture.parties.map((p) => p.kind));
    for (const k of ['pcp', 'cardiology', 'vascular', 'lab', 'asc_scheduling', 'pre_admission_testing', 'vendor_rep']) {
      expect(kinds.has(k as Party['kind'])).toBe(true);
    }
  });
});
