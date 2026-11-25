import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryConsentStore, type ConsentRecord } from './consent.js';
import { FakeLocationDirectory, FakeMessagingProvider } from './fakes.js';
import {
  InMemoryMessageStore,
  PatientMessenger,
  channelOrder,
  type MessageRequest,
} from './messenger.js';
import { InMemoryTenDlcRegistry } from './ten-dlc.js';
import type { Channel, Clock, Recipient } from './types.js';

interface Fixture {
  practiceId: string;
  location: {
    locationId: string;
    displayName: string;
    smsNumber: string;
    voiceNumber: string;
    email: string;
  };
  patients: {
    patientId: string;
    timeZone: string;
    addresses: { phone?: string; email?: string; portalUserId?: string };
    consents: { channel: Channel; source: ConsentRecord['source']; grantedAt: string }[];
    optOutAt?: string;
    contact?: {
      contactId: string;
      addresses: { phone: string };
      consents: {
        channel: Channel;
        source: ConsentRecord['source'];
        grantedAt: string;
        messageTypes: ConsentRecord['messageTypes'];
      }[];
    };
  }[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../tests/fixtures/messaging/patients-consent-states.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

class MutableClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return this.t;
  }
  set(iso: string) {
    this.t = new Date(iso);
  }
}

function patient(id: string) {
  const p = fixture.patients.find((x) => x.patientId === id);
  if (!p) throw new Error(id);
  return p;
}

describe('PatientMessenger', () => {
  let provider: FakeMessagingProvider;
  let consent: InMemoryConsentStore;
  let store: InMemoryMessageStore;
  let tenDlc: InMemoryTenDlcRegistry;
  let clock: MutableClock;
  let messenger: PatientMessenger;
  const practiceId = fixture.practiceId;

  async function seed() {
    for (const p of fixture.patients) {
      for (const c of p.consents) {
        await consent.addConsent({
          practiceId,
          recipient: { kind: 'patient', patientId: p.patientId },
          channel: c.channel,
          source: c.source,
          grantedAt: new Date(c.grantedAt),
        });
      }
      if (p.optOutAt) {
        await consent.addOptOut({
          practiceId,
          recipient: { kind: 'patient', patientId: p.patientId },
          at: new Date(p.optOutAt),
          receivedOn: 'sms',
          keyword: 'STOP',
        });
      }
      if (p.contact) {
        for (const c of p.contact.consents) {
          await consent.addConsent({
            practiceId,
            recipient: { kind: 'contact', patientId: p.patientId, contactId: p.contact.contactId },
            channel: c.channel,
            source: c.source,
            grantedAt: new Date(c.grantedAt),
            ...(c.messageTypes ? { messageTypes: c.messageTypes } : {}),
          });
        }
      }
    }
  }

  function request(patientId: string, over: Partial<MessageRequest> = {}): MessageRequest {
    const p = patient(patientId);
    return {
      practiceId,
      caseId: 'case-1',
      locationId: fixture.location.locationId,
      recipient: { kind: 'patient', patientId },
      addresses: p.addresses,
      patientTimeZone: p.timeZone,
      messageType: 'appointment_reminder',
      subject: 'Appointment reminder',
      body: 'Reminder: please arrive at 8:15am on Tuesday.',
      ...over,
    };
  }

  beforeEach(async () => {
    provider = new FakeMessagingProvider();
    consent = new InMemoryConsentStore();
    store = new InMemoryMessageStore();
    tenDlc = new InMemoryTenDlcRegistry();
    tenDlc.set({ practiceId, brand: 'approved', campaign: 'approved' });
    clock = new MutableClock(new Date('2026-03-03T16:00:00Z')); // 10:00 CST
    const locations = new FakeLocationDirectory();
    locations.set(practiceId, fixture.location);
    messenger = new PatientMessenger({
      provider,
      locations,
      consent,
      store,
      tenDlc,
      clock,
      enabled: true,
    });
    await seed();
  });

  it('scenario 1: compliant send from the location number, automated, no clinical terms', async () => {
    const rec = await messenger.send(request('pt-consented-central'));
    expect(rec.state).toBe('sent');
    expect(provider.sent).toHaveLength(1);
    const m = provider.sent[0]!;
    expect(m.channel).toBe('sms');
    expect(m.from).toBe(fixture.location.smsNumber);
    expect(m.body.toLowerCase()).toContain('automated assistant');
    expect(m.body).toContain(fixture.location.displayName);
  });

  it('scenario 2: opted-out patient gets nothing, 22:00 message is held until 08:00', async () => {
    const stopped = await messenger.send(request('pt-stopped'));
    expect(stopped.state).toBe('blocked');
    expect(stopped.blockedReason).toBe('opted_out');
    expect(provider.sent).toHaveLength(0);

    clock.set('2026-03-04T04:00:00Z'); // 22:00 CST Mar 3
    const held = await messenger.send(request('pt-consented-central'));
    expect(held.state).toBe('held');
    expect(held.releaseAt?.toISOString()).toBe('2026-03-04T14:00:00.000Z');
    expect(provider.sent).toHaveLength(0);

    clock.set('2026-03-04T13:59:00Z');
    expect(await messenger.releaseDue()).toHaveLength(0);
    clock.set('2026-03-04T14:00:00Z');
    const released = await messenger.releaseDue();
    expect(released[0]?.state).toBe('sent');
    expect(provider.sent).toHaveLength(1);
  });

  it('sends nothing without a consent record', async () => {
    const rec = await messenger.send(request('pt-no-consent'));
    expect(rec.state).toBe('blocked');
    expect(rec.blockedReason).toBe('no_consent');
    expect(provider.sent).toHaveLength(0);
  });

  it('STOP on email opts the patient out of SMS too, and cancels held messages', async () => {
    clock.set('2026-03-04T04:00:00Z');
    const held = await messenger.send(request('pt-consented-central'));
    expect(held.state).toBe('held');
    const reply = await messenger.handleInbound({
      practiceId,
      recipient: { kind: 'patient', patientId: 'pt-consented-central' },
      channel: 'email',
      text: 'STOP',
      practiceName: fixture.location.displayName,
    });
    expect(reply.keyword).toBe('stop');
    expect((await store.get(held.id))?.state).toBe('blocked');
    clock.set('2026-03-04T14:00:00Z');
    expect(await messenger.releaseDue()).toHaveLength(0);
    const after = await messenger.send(request('pt-consented-central'));
    expect(after.state).toBe('blocked');
    expect(provider.sent).toHaveLength(0);
  });

  it('STOP leaves other patients and unrelated held messages alone; START re-opts in on that channel', async () => {
    clock.set('2026-03-04T04:00:00Z');
    const other = await messenger.send(request('pt-consented-central'));
    await messenger.handleInbound({
      practiceId,
      recipient: { kind: 'patient', patientId: 'pt-stopped' },
      channel: 'sms',
      text: 'STOP',
      practiceName: 'P',
    });
    expect((await store.get(other.id))?.state).toBe('held');

    clock.set('2026-03-05T16:00:00Z');
    const start = await messenger.handleInbound({
      practiceId,
      recipient: { kind: 'patient', patientId: 'pt-stopped' },
      channel: 'sms',
      text: 'START',
      practiceName: 'P',
    });
    expect(start.keyword).toBe('start');
    clock.set('2026-03-05T16:01:00Z');
    const rec = await messenger.send(request('pt-stopped'));
    expect(rec.state).toBe('sent');
    expect(rec.attempts[0]?.channel).toBe('sms');
    const help = await messenger.handleInbound({
      practiceId,
      recipient: { kind: 'patient', patientId: 'pt-stopped' },
      channel: 'sms',
      text: 'HELP',
      practiceName: 'P',
    });
    expect(help.reply).toContain('STOP');
    const none = await messenger.handleInbound({
      practiceId,
      recipient: { kind: 'patient', patientId: 'pt-stopped' },
      channel: 'sms',
      text: 'ok thanks',
      practiceName: 'P',
    });
    expect(none).toEqual({ keyword: 'none' });
  });

  it('rejects diagnosis and procedure names without sending', async () => {
    const rec = await messenger.send(
      request('pt-consented-central', { body: 'Prep for your bunionectomy' }),
    );
    expect(rec.state).toBe('rejected');
    expect(rec.violations?.[0]?.term).toBe('bunionectomy');
    const rec2 = await messenger.send(
      request('pt-consented-central', {
        body: 'Prep for your Lapidus procedure',
        caseClinicalTerms: ['Lapidus'],
      }),
    );
    expect(rec2.state).toBe('rejected');
    expect(provider.sent).toHaveLength(0);
  });

  it('allows richer detail in email when SMS text is neutral', async () => {
    provider.failingChannels.add('sms');
    const rec = await messenger.send(
      request('pt-consented-central', {
        detailBody: 'Instructions for your bunionectomy are in the portal.',
      }),
    );
    expect(rec.state).toBe('sent');
    expect(provider.sent[0]?.channel).toBe('email');
    expect(provider.sent[0]?.body).toContain('bunionectomy');
  });

  it('falls back SMS to email to portal on immediate failures, then fails', async () => {
    provider.failingChannels.add('sms').add('email');
    const rec = await messenger.send(request('pt-consented-central'));
    expect(rec.attempts.map((a) => a.channel)).toEqual(['sms', 'email', 'portal']);
    expect(rec.state).toBe('sent');
    expect(provider.sent[0]?.channel).toBe('portal');

    provider.failingChannels.add('portal');
    const rec2 = await messenger.send(request('pt-consented-central'));
    expect(rec2.state).toBe('failed');
    expect(rec2.attempts.every((a) => a.status === 'failed')).toBe(true);
  });

  it('tracks delivery receipts and falls back on a failed receipt', async () => {
    const rec = await messenger.send(request('pt-consented-central'));
    const smsId = rec.attempts[0]!.providerMessageId;
    const failed = await messenger.recordDeliveryReceipt(smsId, 'failed', 'carrier_rejected');
    expect(failed?.attempts.map((a) => a.channel)).toEqual(['sms', 'email']);
    expect(failed?.attempts[0]).toMatchObject({ status: 'failed', errorCode: 'carrier_rejected' });
    expect(failed?.state).toBe('sent');
    const emailId = failed!.attempts[1]!.providerMessageId;
    const done = await messenger.recordDeliveryReceipt(emailId, 'delivered');
    expect(done?.state).toBe('delivered');
    expect(await messenger.recordDeliveryReceipt('nope', 'delivered')).toBeNull();
  });

  it('holds a fallback that would go out during quiet hours', async () => {
    clock.set('2026-03-04T01:59:00Z'); // 19:59 CST
    const rec = await messenger.send(request('pt-consented-central'));
    clock.set('2026-03-04T02:05:00Z');
    const after = await messenger.recordDeliveryReceipt(
      rec.attempts[0]!.providerMessageId,
      'failed',
    );
    expect(after?.state).toBe('held');
    expect(provider.sent).toHaveLength(1);
  });

  it('re-checks consent when a held message is released', async () => {
    clock.set('2026-03-04T04:00:00Z');
    const held = await messenger.send(request('pt-consented-central'));
    await consent.addOptOut({
      practiceId,
      recipient: { kind: 'patient', patientId: 'pt-consented-central' },
      at: new Date('2026-03-04T05:00:00Z'),
      receivedOn: 'sms',
      keyword: 'STOP',
    });
    clock.set('2026-03-04T14:00:00Z');
    const [rel] = await messenger.releaseDue();
    expect(rel?.id).toBe(held.id);
    expect(rel?.state).toBe('blocked');
  });

  it('skips SMS when 10DLC is not approved and uses email', async () => {
    tenDlc.set({ practiceId, brand: 'approved', campaign: 'pending' });
    const rec = await messenger.send(request('pt-consented-central'));
    expect(rec.skipped).toContainEqual({ channel: 'sms', reason: 'sms_not_registered' });
    expect(provider.sent[0]?.channel).toBe('email');
  });

  it('skips channels with no address and records the reason', async () => {
    const rec = await messenger.send(
      request('pt-consented-central', { addresses: { phone: '+13125550111' } }),
    );
    expect(rec.state).toBe('sent');
    const rec2 = await messenger.send(request('pt-consented-central', { addresses: {} }));
    expect(rec2.state).toBe('blocked');
    expect(rec2.blockedReason).toBe('no_address');
  });

  it('limits authorized contacts to consented message types', async () => {
    const p = patient('pt-contact-limited');
    const contact = p.contact!;
    const recipient: Recipient = {
      kind: 'contact',
      patientId: p.patientId,
      contactId: contact.contactId,
    };
    const base = request('pt-contact-limited', {
      recipient,
      addresses: contact.addresses,
      messageType: 'pre_op_instructions',
    });
    expect((await messenger.send(base)).state).toBe('sent');
    const billing = await messenger.send({ ...base, messageType: 'billing' });
    expect(billing.state).toBe('blocked');
    expect(billing.blockedReason).toBe('message_type_not_consented');
    // The patient's own (absent) consent does not leak to the contact, and vice versa.
    const patientSend = await messenger.send(request('pt-contact-limited'));
    expect(patientSend.state).toBe('blocked');
  });

  it('sends voice reminders under the same rules', async () => {
    await consent.addConsent({
      practiceId,
      recipient: { kind: 'patient', patientId: 'pt-consented-central' },
      channel: 'voice',
      source: 'verbal_recorded',
      grantedAt: new Date('2026-01-05T15:00:00Z'),
    });
    expect(channelOrder(true)[0]).toBe('voice');
    expect(channelOrder(false)).toEqual(['sms', 'email', 'portal']);
    const rec = await messenger.send(request('pt-consented-central', { preferVoice: true }));
    expect(provider.sent[0]).toMatchObject({
      channel: 'voice',
      from: fixture.location.voiceNumber,
    });
    expect(provider.sent[0]?.body).toContain('Press 1 to confirm');
    expect(rec.state).toBe('sent');

    // No voice consent: falls to SMS. Quiet hours hold voice too.
    const rec2 = await messenger.send(request('pt-stopped', { preferVoice: true }));
    expect(rec2.state).toBe('blocked');
    clock.set('2026-03-04T04:00:00Z');
    const held = await messenger.send(request('pt-consented-central', { preferVoice: true }));
    expect(held.state).toBe('held');
  });

  it('is disabled unless the feature flag is on', async () => {
    const off = new PatientMessenger({
      provider,
      locations: new FakeLocationDirectory(),
      consent,
      store,
      tenDlc,
      clock,
    });
    expect((await off.send(request('pt-consented-central'))).state).toBe('disabled');
    expect(provider.sent).toHaveLength(0);
  });

  it('blocks an unknown location and never crosses practices', async () => {
    const unknown = await messenger.send(request('pt-consented-central', { locationId: 'nope' }));
    expect(unknown.blockedReason).toBe('unknown_location');
    const otherPractice = await messenger.send(
      request('pt-consented-central', { practiceId: 'practice-other' }),
    );
    expect(otherPractice.state).toBe('blocked');
    expect(provider.sent).toHaveLength(0);
  });
});
