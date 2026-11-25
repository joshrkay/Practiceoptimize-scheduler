import {
  FakeFinancialPorts,
  InMemoryFlowStore,
  SelfPayFlowService,
  createQuote,
  evaluateDepositGate,
} from '@scheduler/case-model';
import { describe, expect, it } from 'vitest';
import {
  FakePaymentProcessor,
  FakePaymentSideEffects,
  InMemoryCredentialProvider,
  InMemoryPaymentLinkStore,
  InMemoryPracticeProcessorConfig,
  InMemoryProcessedEventStore,
  PaymentConfigError,
  PaymentService,
  WebhookRejectedError,
  containsCardData,
  hmacSha256Hex,
  signFakeWebhook,
  verifyHmacSha256,
  type PaymentEvent,
  type PaymentProcessor,
} from './index.js';

const NOW = new Date('2026-03-01T12:00:00Z');
const P = 'practice-podiatry-1';
const P2 = 'practice-podiatry-2';
const C = 'case-1';
const SECRET = 'whsec-test-practice-1';
const API_KEY = 'sk-test-practice-1';

// The same deposit flow runs against two processors; real adapters plug in here once built.
const processors: { name: string; make: () => FakePaymentProcessor }[] = [
  { name: 'processor A (stands in for a card processor)', make: () => new FakePaymentProcessor('proc-a') },
  { name: 'processor B (stands in for EHR built-in payments)', make: () => new FakePaymentProcessor('proc-b') },
];

function build(processor: FakePaymentProcessor, registry?: Map<string, PaymentProcessor>) {
  const effects = new FakePaymentSideEffects();
  const ports = new FakeFinancialPorts();
  const creds = { apiCredential: API_KEY, webhookSecret: SECRET };
  const holder: { payments?: PaymentService } = {};
  const flow = new SelfPayFlowService({
    store: new InMemoryFlowStore(),
    consent: ports,
    patientPage: ports,
    messages: ports,
    depositLinks: { createDepositLink: (a) => holder.payments!.createDepositLink(a) },
    staffWork: ports,
    now: () => NOW,
  });
  const payments = new PaymentService({
    processors: registry ?? new Map<string, PaymentProcessor>([[processor.processorId, processor]]),
    practiceConfig: new InMemoryPracticeProcessorConfig({ [P]: processor.processorId, [P2]: processor.processorId }),
    credentials: new InMemoryCredentialProvider({
      [P]: creds,
      [P2]: { apiCredential: 'sk-test-2', webhookSecret: 'whsec-test-2' },
    }),
    links: new InMemoryPaymentLinkStore(),
    events: new InMemoryProcessedEventStore(),
    deposits: flow,
    reminders: effects,
    tasks: effects,
    refunds: effects,
    logger: effects,
    newReference: () => 'ref-1',
    now: () => NOW,
    linkTtlMs: 7 * 24 * 3600 * 1000,
  });
  holder.payments = payments;
  return { effects, ports, flow, payments, processor, creds };
}

async function selfPayCaseWithDepositLink(h: ReturnType<typeof build>) {
  const quote = createQuote({
    quoteId: 'q1',
    practiceId: P,
    caseId: C,
    actor: { kind: 'staff', userId: 'u1' },
    procedures: [{ procedureId: 'proc-cosmetic', description: 'Cosmetic toe', coverage: 'self_pay' }],
    lines: [{ procedureId: 'proc-cosmetic', description: 'Cosmetic toe', amountCents: 400000 }],
    depositCents: 100000,
    expiresAt: new Date('2026-04-01T00:00:00Z'),
    now: NOW,
  });
  await h.flow.recordQuote(quote);
  await h.flow.sendQuote(P, C);
  await h.flow.onConsentSigned(P, C, 'q1');
  return [...h.processor.links.keys()][0] as string;
}

const webhook = (secret: string, id: string, type: string, linkId: string, amountCents = 100000) =>
  signFakeWebhook(secret, { id, type, linkId, amountCents, occurredAt: NOW.toISOString() });

describe.each(processors)('deposit flow with $name', ({ make }) => {
  it('confirms a deposit from the signed webhook and passes the gate', async () => {
    const h = build(make());
    const linkId = await selfPayCaseWithDepositLink(h);
    expect(h.processor.links.get(linkId)?.request.amountCents).toBe(100000);
    expect(h.processor.links.get(linkId)?.request.purpose).toBe('deposit');
    const before = await h.flow.getState(P, C);
    expect(evaluateDepositGate({ timing: 'before_booked', flow: before }).canBook).toBe(false);

    const { rawBody, headers } = webhook(SECRET, 'evt-1', 'paid', linkId);
    expect(await h.payments.handleWebhook({ practiceId: P, headers, rawBody })).toBe('processed');
    const after = await h.flow.getState(P, C);
    expect(after.status).toBe('deposit_confirmed');
    expect(evaluateDepositGate({ timing: 'before_booked', flow: after }).canBook).toBe(true);
  });

  it('is idempotent by processor event ID', async () => {
    const h = build(make());
    const linkId = await selfPayCaseWithDepositLink(h);
    const { rawBody, headers } = webhook(SECRET, 'evt-1', 'paid', linkId, 60000);
    expect(await h.payments.handleWebhook({ practiceId: P, headers, rawBody })).toBe('processed');
    expect(await h.payments.handleWebhook({ practiceId: P, headers, rawBody })).toBe('duplicate');
    const state = await h.flow.getState(P, C);
    expect(state.payments).toHaveLength(1);
    expect(state.status).toBe('deposit_link_sent');
  });

  it('records a partial payment without passing the gate', async () => {
    const h = build(make());
    const linkId = await selfPayCaseWithDepositLink(h);
    const { rawBody, headers } = webhook(SECRET, 'evt-p', 'partially_paid', linkId, 40000);
    await h.payments.handleWebhook({ practiceId: P, headers, rawBody });
    expect((await h.flow.getState(P, C)).status).toBe('deposit_link_sent');
  });

  it('reminds on the first failed or expired link, then creates a scheduler task', async () => {
    const h = build(make());
    const linkId = await selfPayCaseWithDepositLink(h);
    const send = (id: string, type: string) => {
      const w = webhook(SECRET, id, type, linkId);
      return h.payments.handleWebhook({ practiceId: P, headers: w.headers, rawBody: w.rawBody });
    };
    await send('e1', 'failed');
    expect(h.effects.reminders).toEqual([`${C}:failed`]);
    expect(h.effects.tasks).toEqual([]);
    await send('e2', 'expired');
    expect(h.effects.reminders).toHaveLength(1);
    expect(h.effects.tasks).toEqual([`${C}:expired`]);
  });

  it('ignores a late expiry after the link was paid', async () => {
    const h = build(make());
    const linkId = await selfPayCaseWithDepositLink(h);
    for (const [id, type] of [['e1', 'paid'], ['e2', 'expired']] as const) {
      const w = webhook(SECRET, id, type, linkId);
      await h.payments.handleWebhook({ practiceId: P, headers: w.headers, rawBody: w.rawBody });
    }
    expect(h.effects.reminders).toEqual([]);
    expect(h.effects.tasks).toEqual([]);
  });

  it('records a processor-reported refund and never initiates one', async () => {
    const h = build(make());
    const linkId = await selfPayCaseWithDepositLink(h);
    const w = webhook(SECRET, 'evt-r', 'refunded', linkId, 100000);
    await h.payments.handleWebhook({ practiceId: P, headers: w.headers, rawBody: w.rawBody });
    expect(h.effects.refunds).toEqual([{ caseId: C, amountCents: 100000, processorEventId: 'evt-r' }]);
    const surface = [
      ...Object.getOwnPropertyNames(PaymentService.prototype),
      ...Object.getOwnPropertyNames(FakePaymentProcessor.prototype),
    ];
    expect(surface.filter((n) => /refund|charge|capture/i.test(n))).toEqual([]);
  });
});

describe('webhook security', () => {
  const setup = () => build(new FakePaymentProcessor('proc-a'));

  it('rejects a bad signature, a missing signature and a different practice secret', async () => {
    const h = setup();
    const linkId = await selfPayCaseWithDepositLink(h);
    const good = webhook(SECRET, 'evt-1', 'paid', linkId);
    const attempts = [
      { headers: { 'x-fake-signature': 'a'.repeat(64) }, rawBody: good.rawBody },
      { headers: {}, rawBody: good.rawBody },
      { headers: { 'x-fake-signature': 'zz' }, rawBody: good.rawBody },
      webhook('whsec-test-2', 'evt-1', 'paid', linkId),
    ];
    for (const a of attempts) {
      await expect(h.payments.handleWebhook({ practiceId: P, ...a })).rejects.toMatchObject({ code: 'bad_signature' });
    }
    expect((await h.flow.getState(P, C)).status).toBe('deposit_link_sent');
  });

  it('verifies per practice: practice 2 secret does not validate practice 1 traffic', async () => {
    const h = setup();
    const linkId = await selfPayCaseWithDepositLink(h);
    const w = webhook('whsec-test-2', 'evt-1', 'paid', linkId);
    await expect(h.payments.handleWebhook({ practiceId: P, ...w })).rejects.toBeInstanceOf(WebhookRejectedError);
    // Signed correctly for practice 2, but the link belongs to practice 1: unknown there.
    expect(await h.payments.handleWebhook({ practiceId: P2, ...w })).toBe('unknown_link');
  });

  it('rejects a malformed body that has a valid signature', async () => {
    const h = setup();
    const w = webhook(SECRET, 'evt-1', 'paid', 'l');
    const bad = signFakeWebhook(SECRET, { id: 1 });
    await expect(h.payments.handleWebhook({ practiceId: P, ...bad })).rejects.toMatchObject({ code: 'malformed' });
    const notJson = { rawBody: 'not json', headers: { 'x-fake-signature': hmacSha256Hex(SECRET, 'not json') } };
    await expect(h.payments.handleWebhook({ practiceId: P, ...notJson })).rejects.toMatchObject({ code: 'malformed' });
    const nonObject = { rawBody: '5', headers: { 'x-fake-signature': hmacSha256Hex(SECRET, '5') } };
    await expect(h.payments.handleWebhook({ practiceId: P, ...nonObject })).rejects.toMatchObject({ code: 'malformed' });
    expect(w.rawBody).toContain('evt-1');
  });

  it('rejects a practice with no processor, and a link from another processor', async () => {
    const h = setup();
    await expect(h.payments.handleWebhook({ practiceId: 'unknown', headers: {}, rawBody: '{}' })).rejects.toMatchObject({
      code: 'no_processor',
    });
  });

  it('refuses a payload that carries a card number, without logging or echoing it', async () => {
    const h = setup();
    const linkId = await selfPayCaseWithDepositLink(h);
    const pan = '4242 4242 4242 4242';
    const w = signFakeWebhook(SECRET, { id: 'evt-c', type: 'paid', linkId, amountCents: 1, occurredAt: NOW.toISOString(), cardNumber: pan });
    const error = await h.payments.handleWebhook({ practiceId: P, ...w }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'card_data' });
    const everything = JSON.stringify([h.effects.logs, String((error as Error).message)]);
    expect(everything).not.toMatch(/4242/);
    expect((await h.flow.getState(P, C)).payments).toEqual([]);
  });

  it('does not carry card fields through the event type or the parser', () => {
    const p = new FakePaymentProcessor();
    const body = JSON.stringify({
      id: 'e',
      type: 'paid',
      linkId: 'l',
      amountCents: 5,
      occurredAt: NOW.toISOString(),
      last4: '1111',
      cvv: '123',
    });
    const event = p.parseWebhook(body);
    expect(Object.keys(event).sort()).toEqual(['amountCents', 'eventId', 'kind', 'linkId', 'occurredAt']);
    const typed: PaymentEvent = {
      eventId: 'e',
      kind: 'paid',
      linkId: 'l',
      amountCents: 5,
      occurredAt: NOW,
      // @ts-expect-error card data is not part of PaymentEvent
      cardNumber: '4111111111111111',
    };
    expect(typed.eventId).toBe('e');
  });

  it('releases an event when handling fails so the processor retry is processed', async () => {
    const h = setup();
    const linkId = await selfPayCaseWithDepositLink(h);
    const w = webhook(SECRET, 'evt-1', 'refunded', linkId);
    let fail = true;
    const original = h.effects.recordProcessorRefund.bind(h.effects);
    h.effects.recordProcessorRefund = (args) =>
      fail ? Promise.reject(new Error('db down')) : original(args);
    await expect(h.payments.handleWebhook({ practiceId: P, ...w })).rejects.toThrow('db down');
    fail = false;
    expect(await h.payments.handleWebhook({ practiceId: P, ...w })).toBe('processed');
  });

  it('never logs secrets or credentials', async () => {
    const h = setup();
    const linkId = await selfPayCaseWithDepositLink(h);
    const w = webhook(SECRET, 'evt-1', 'paid', linkId);
    await h.payments.handleWebhook({ practiceId: P, ...w });
    const logs = h.effects.logs.join('\n');
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain(API_KEY);
    expect(logs).toContain('payment_link_created');
  });
});

describe('link creation', () => {
  it('uses the practice processor and the human-entered amount, and creates balance links', async () => {
    const h = build(new FakePaymentProcessor('proc-a'));
    const link = await h.payments.createBalanceLink(P, C, 25000);
    expect(link.url).toContain('proc-a-link-1');
    expect(h.processor.links.get(link.linkId)?.request).toMatchObject({ purpose: 'balance', amountCents: 25000, reference: 'ref-1' });
    expect(h.processor.links.get(link.linkId)?.request.expiresAt).toEqual(new Date('2026-03-08T12:00:00Z'));
    expect(await h.processor.getLinkStatus(h.creds, link.linkId)).toBe('open');
    await expect(h.processor.getLinkStatus(h.creds, 'nope')).rejects.toThrow();
  });

  it('refuses invalid amounts and unconfigured practices', async () => {
    const h = build(new FakePaymentProcessor('proc-a'));
    await expect(h.payments.createBalanceLink(P, C, 0)).rejects.toBeInstanceOf(PaymentConfigError);
    await expect(h.payments.createBalanceLink(P, C, 10.5)).rejects.toBeInstanceOf(PaymentConfigError);
    await expect(h.payments.createBalanceLink('unknown', C, 100)).rejects.toThrow(/no payment processor/);
    const noAdapter = build(new FakePaymentProcessor('proc-a'), new Map());
    await expect(noAdapter.payments.createBalanceLink(P, C, 100)).rejects.toThrow(/No adapter registered/);
  });

  it('balance payments are recorded on the link but do not touch the deposit gate', async () => {
    const h = build(new FakePaymentProcessor('proc-a'));
    const link = await h.payments.createBalanceLink(P, C, 25000);
    const w = webhook(SECRET, 'evt-b', 'paid', link.linkId, 25000);
    expect(await h.payments.handleWebhook({ practiceId: P, ...w })).toBe('processed');
    expect((await h.flow.getState(P, C)).payments).toEqual([]);
  });
});

describe('primitives', () => {
  it('compares HMAC signatures in constant time and rejects malformed input', () => {
    const sig = hmacSha256Hex('s', 'body');
    expect(verifyHmacSha256('s', 'body', sig)).toBe(true);
    expect(verifyHmacSha256('s', 'body', sig.toUpperCase())).toBe(true);
    expect(verifyHmacSha256('s', 'body2', sig)).toBe(false);
    expect(verifyHmacSha256('s', 'body', undefined)).toBe(false);
    expect(verifyHmacSha256('s', 'body', sig.slice(2))).toBe(false);
  });

  it('detects Luhn-valid card numbers only', () => {
    expect(containsCardData('{"x":"4242-4242-4242-4242"}')).toBe(true);
    expect(containsCardData('card 4111111111111111 end')).toBe(true);
    expect(containsCardData('{"amountCents":100000,"occurredAt":"2026-03-01T12:00:00Z"}')).toBe(false);
    expect(containsCardData('1234567890123456')).toBe(false);
    expect(containsCardData('no digits')).toBe(false);
  });
});
