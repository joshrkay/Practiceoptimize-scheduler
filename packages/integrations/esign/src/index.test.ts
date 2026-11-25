import { describe, expect, it } from 'vitest';
import events from '../../../../tests/fixtures/esign/envelope-events.json';
import {
  ESignService,
  FakeAudit,
  FakeFiling,
  FakeFormLibrary,
  FakeReadiness,
  FakeReminders,
  FakeTasks,
  InClinicOnlyFormError,
  InMemoryESignProvider,
  InMemoryEnvelopeStore,
  InvalidWebhookSignatureError,
  asVerifiedPatientSession,
  selectProvider,
  signPayload,
  verifySignature,
  type ApprovedForm,
  type CreateEnvelopeRequest,
  type ProviderEvent,
} from './index.js';

const P = 'practice-podiatry-1';
const C = 'case-bunionectomy-1';
const forms: ApprovedForm[] = [
  { formId: 'financial-policy', version: '3', title: 'Financial policy', delivery: 'remote' },
  { formId: 'health-history', version: '2', title: 'Health history', delivery: 'remote' },
  {
    formId: 'surgical-consent-bunionectomy',
    version: '1',
    title: 'Surgical consent, bunionectomy',
    delivery: 'in-clinic-only',
  },
];

function setup(items = ['financial-policy:3', 'health-history:2']) {
  const provider = new InMemoryESignProvider('whsec-synthetic');
  const readiness = new FakeReadiness(
    items.map((s, i) => {
      const [formId, formVersion] = s.split(':') as [string, string];
      return { readinessItemId: `item-${i + 1}`, formId, formVersion };
    }),
  );
  const filing = new FakeFiling();
  const reminders = new FakeReminders();
  const tasks = new FakeTasks();
  const audit = new FakeAudit();
  const service = new ESignService({
    provider,
    library: new FakeFormLibrary(forms),
    readiness,
    store: new InMemoryEnvelopeStore(),
    filing,
    reminders,
    tasks,
    audit,
  });
  return { provider, readiness, filing, reminders, tasks, audit, service };
}

const ev = (eventId: string, envelopeId: string, type: ProviderEvent['type']): ProviderEvent => ({
  eventId,
  envelopeId,
  type,
  occurredAt: '2026-03-02T15:00:00Z',
});

describe('scenario 1: forms signed', () => {
  it('files both PDFs to case and chart and closes both readiness items', async () => {
    const s = setup();
    const res = await s.service.sendRequiredForms(P, C, 'patient-ref-1');
    expect(res.sent).toEqual(['item-1', 'item-2']);
    expect(s.reminders.active.size).toBe(2);

    for (const [i, id] of ['env-1', 'env-2'].entries()) {
      const d = s.provider.emit(ev(`e${i}`, id, 'signed'));
      expect(await s.service.handleWebhook(d.rawBody, d.signature)).toBe('applied');
    }
    expect(s.filing.caseDocs).toHaveLength(2);
    expect(s.filing.chartDocs).toEqual(s.filing.caseDocs);
    expect(s.readiness.closed).toEqual(['item-1', 'item-2']);
    expect(s.reminders.active.size).toBe(0);
  });

  it('sending again does not create duplicate envelopes', async () => {
    const s = setup();
    await s.service.sendRequiredForms(P, C, 'p');
    const again = await s.service.sendRequiredForms(P, C, 'p');
    expect(again.alreadySent).toHaveLength(2);
    expect(s.provider.created).toHaveLength(2);
  });

  it('fixture events: sent, viewed, signed in order', async () => {
    const s = setup(['financial-policy:3']);
    await s.service.sendRequiredForms(P, C, 'p');
    const verified = asVerifiedPatientSession({ practiceId: P, caseId: C });
    const seen: string[] = [];
    for (const e of events as ProviderEvent[]) {
      const d = s.provider.emit(e);
      await s.service.handleWebhook(d.rawBody, d.signature);
      seen.push((await s.service.listForms(verified))[0]!.status);
    }
    expect(seen).toEqual(['sent', 'viewed', 'signed']);
  });
});

describe('scenario 2: in-clinic consent', () => {
  it('is never sent and becomes a clinic task', async () => {
    const s = setup(['surgical-consent-bunionectomy:1', 'financial-policy:3']);
    const res = await s.service.sendRequiredForms(P, C, 'p');
    expect(res.inClinic).toEqual(['item-1']);
    expect(s.provider.created.map((r) => r.form.formId)).toEqual(['financial-policy']);
    expect(await s.service.createInClinicTasks(P, C)).toBe(1);
    expect(s.tasks.tasks[0]?.reason).toBe('in-clinic-form');
  });

  it('is rejected by the type and by the provider at runtime', async () => {
    const provider = new InMemoryESignProvider('s');
    const inClinic = forms[2]!;
    // @ts-expect-error in-clinic-only forms are not assignable to RemoteForm
    const bad: CreateEnvelopeRequest = { practiceId: P, caseId: C, form: inClinic, patientRef: 'p', idempotencyKey: 'k' };
    await expect(provider.createEnvelope(bad)).rejects.toBeInstanceOf(InClinicOnlyFormError);
  });

  it('rejects forms missing from the approved library', async () => {
    const s = setup(['free-text-form:9']);
    await expect(s.service.sendRequiredForms(P, C, 'p')).rejects.toThrow('approved library');
  });
});

describe('status tracking', () => {
  it('is idempotent by event ID and ignores regressions', async () => {
    const s = setup(['financial-policy:3']);
    await s.service.sendRequiredForms(P, C, 'p');
    const signed = s.provider.emit(ev('x1', 'env-1', 'signed'));
    expect(await s.service.handleWebhook(signed.rawBody, signed.signature)).toBe('applied');
    expect(await s.service.handleWebhook(signed.rawBody, signed.signature)).toBe('duplicate');
    const late = s.provider.deliver(ev('x2', 'env-1', 'viewed'));
    expect(await s.service.handleWebhook(late.rawBody, late.signature)).toBe('ignored');
    expect(s.filing.caseDocs).toHaveLength(1);
    expect(s.readiness.closed).toHaveLength(1);
  });

  it('ignores unknown envelopes', async () => {
    const s = setup();
    const d = s.provider.deliver(ev('x', 'env-999', 'viewed'));
    expect(await s.service.handleWebhook(d.rawBody, d.signature)).toBe('ignored');
  });

  it('retries filing after a chart failure without losing the event', async () => {
    const s = setup(['financial-policy:3']);
    await s.service.sendRequiredForms(P, C, 'p');
    const d = s.provider.emit(ev('x1', 'env-1', 'signed'));
    s.filing.failChart = true;
    await expect(s.service.handleWebhook(d.rawBody, d.signature)).rejects.toThrow('chart');
    expect(s.readiness.closed).toEqual([]);
    s.filing.failChart = false;
    expect(await s.service.handleWebhook(d.rawBody, d.signature)).toBe('applied');
    expect(s.readiness.closed).toEqual(['item-1']);
  });

  it('a decline creates a scheduler task and stops reminders', async () => {
    const s = setup(['financial-policy:3']);
    await s.service.sendRequiredForms(P, C, 'p');
    const d = s.provider.emit(ev('x1', 'env-1', 'declined'));
    await s.service.handleWebhook(d.rawBody, d.signature);
    expect(s.tasks.tasks[0]?.reason).toBe('form-declined');
    expect(s.reminders.active.size).toBe(0);
    expect(s.readiness.closed).toEqual([]);
  });

  it('expiry creates a task, stops reminders and leaves the item open', async () => {
    const s = setup(['financial-policy:3']);
    await s.service.sendRequiredForms(P, C, 'p');
    const d = s.provider.emit(ev('x1', 'env-1', 'expired'));
    await s.service.handleWebhook(d.rawBody, d.signature);
    expect(s.tasks.tasks[0]?.reason).toBe('form-expired');
    expect(s.readiness.closed).toEqual([]);
    expect(s.audit.entries.map((a) => a.action)).toContain('esign.expired');
  });
});

describe('webhook verification', () => {
  it('rejects bad, missing and wrong-length signatures', async () => {
    const s = setup();
    const d = s.provider.deliver(ev('x', 'env-1', 'viewed'));
    for (const sig of ['', 'abc', signPayload('wrong', d.rawBody)]) {
      await expect(s.service.handleWebhook(d.rawBody, sig)).rejects.toBeInstanceOf(
        InvalidWebhookSignatureError,
      );
    }
    expect(verifySignature('k', 'body', signPayload('k', 'body'))).toBe(true);
    expect(verifySignature('k', 'body2', signPayload('k', 'body'))).toBe(false);
  });

  it('rejects a malformed payload that is correctly signed', () => {
    const p = new InMemoryESignProvider('k');
    const raw = JSON.stringify({ eventId: 'a', type: 'bogus' });
    expect(() => p.verifyWebhook(raw, signPayload('k', raw))).toThrow('Malformed');
  });
});

describe('patient page and provider fake', () => {
  it('lists forms for the verified session only, hiding links once finished', async () => {
    const s = setup();
    await s.service.sendRequiredForms(P, C, 'p');
    const d = s.provider.emit(ev('x1', 'env-1', 'signed'));
    await s.service.handleWebhook(d.rawBody, d.signature);
    const list = await s.service.listForms(asVerifiedPatientSession({ practiceId: P, caseId: C }));
    expect(list.map((f) => f.status)).toEqual(['signed', 'sent']);
    expect(list[0]?.signingUrl).toBeNull();
    expect(list[1]?.signingUrl).toContain('env-2');
    const other = await s.service.listForms(
      asVerifiedPatientSession({ practiceId: 'practice-other', caseId: C }),
    );
    expect(other).toEqual([]);
  });

  it('fake provider reports status and gates downloads on signing', async () => {
    const p = new InMemoryESignProvider('k');
    const form = forms[0] as CreateEnvelopeRequest['form'];
    const req = { practiceId: P, caseId: C, form, patientRef: 'p', idempotencyKey: 'k1' };
    const env = await p.createEnvelope(req);
    expect(await p.createEnvelope(req)).toEqual(env);
    expect(await p.getStatus(env.envelopeId)).toBe('sent');
    await expect(p.downloadSignedDocument(env.envelopeId)).rejects.toThrow('not signed');
    await expect(p.getStatus('nope')).rejects.toThrow('unknown');
    p.emit(ev('e', env.envelopeId, 'signed'));
    expect((await p.downloadSignedDocument(env.envelopeId)).length).toBeGreaterThan(0);
  });

  it('selects the provider from ESIGN_PROVIDER', () => {
    expect(selectProvider('fake', 's')).toBeInstanceOf(InMemoryESignProvider);
    expect(() => selectProvider(undefined, 's')).toThrow('not set');
    expect(() => selectProvider('', 's')).toThrow('not set');
    expect(() => selectProvider('somevendor', 's')).toThrow('no vendor');
  });
});
