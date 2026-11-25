import { describe, expect, it } from 'vitest';
import {
  composeEmail,
  composePortal,
  composeSms,
  composeVoice,
  hasAutomatedDisclosure,
  interpretVoiceKeypress,
  MissingSenderError,
} from './channels.js';
import {
  channelsOptedOutByStop,
  classifyInboundKeyword,
  evaluateConsent,
  type ConsentRecord,
} from './consent.js';
import { findClinicalTerms } from './content-guard.js';
import { canSendSms } from './ten-dlc.js';
import { recipientKey, type SenderIdentity } from './types.js';

const identity: SenderIdentity = {
  locationId: 'loc-1',
  displayName: 'Prairie Foot and Ankle Center',
  smsNumber: '+13125550100',
  voiceNumber: '+13125550101',
  email: 'office@prairie.example.test',
};

describe('content guard', () => {
  it('flags diagnosis and procedure names, case-insensitively', () => {
    expect(findClinicalTerms('Prep for your Bunionectomy').map((v) => v.term)).toContain(
      'bunionectomy',
    );
    expect(findClinicalTerms('Your hammer toe visit').length).toBe(1);
  });

  it('flags the case-specific terms and ignores substrings of other words', () => {
    expect(findClinicalTerms('Re: Lapidus fusion', ['Lapidus fusion'])).toEqual([
      { term: 'Lapidus fusion' },
    ]);
    expect(findClinicalTerms('See you Tuesday at 9am')).toEqual([]);
    expect(findClinicalTerms('bunions', [''])).toEqual([]);
  });

  it('allows the generic word surgery', () => {
    expect(findClinicalTerms('Reminder about your surgery on Tuesday')).toEqual([]);
  });
});

describe('channel composition', () => {
  it('identifies as automated on every channel', () => {
    for (const m of [
      composeSms(identity, 'Reminder: arrive 8:15am.'),
      composeEmail(identity, 'Reminder', 'Arrive 8:15am.'),
      composePortal(identity, 'Reminder', 'Arrive 8:15am.'),
      composeVoice(identity, 'Arrive 8:15am.'),
    ]) {
      expect(hasAutomatedDisclosure(m.body)).toBe(true);
    }
  });

  it('uses the location sender', () => {
    expect(composeSms(identity, 'x').from).toBe('+13125550100');
    expect(composeEmail(identity, 's', 'x').from).toBe('office@prairie.example.test');
    expect(composeVoice(identity, 'x').from).toBe('+13125550101');
    expect(composePortal(identity, 's', 'x').from).toBe(identity.displayName);
  });

  it('throws when the location lacks a sender', () => {
    const bare = { locationId: 'l', displayName: 'N' };
    expect(() => composeSms(bare, 'x')).toThrow(MissingSenderError);
    expect(() => composeEmail(bare, 's', 'x')).toThrow(MissingSenderError);
    expect(() => composeVoice(bare, 'x')).toThrow(MissingSenderError);
  });

  it('interprets voice keypresses', () => {
    expect(interpretVoiceKeypress('1')).toBe('confirm');
    expect(interpretVoiceKeypress('2')).toBe('reach_office');
    expect(interpretVoiceKeypress('9')).toBe('unrecognized');
  });
});

describe('consent policy', () => {
  const patient = { kind: 'patient', patientId: 'p' } as const;
  const base: ConsentRecord = {
    practiceId: 'pr',
    recipient: patient,
    channel: 'sms',
    source: 'intake_form',
    grantedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const now = new Date('2026-02-01T00:00:00Z');

  it('STOP opts out of every automated channel (single policy function)', () => {
    expect(channelsOptedOutByStop('sms')).toEqual(['sms', 'email', 'portal', 'voice']);
    expect(channelsOptedOutByStop('email')).toEqual(['sms', 'email', 'portal', 'voice']);
  });

  it('classifies keywords', () => {
    expect(classifyInboundKeyword(' stop ')).toBe('stop');
    expect(classifyInboundKeyword('Unsubscribe.')).toBe('stop');
    expect(classifyInboundKeyword('start')).toBe('start');
    expect(classifyInboundKeyword('help')).toBe('help');
    expect(classifyInboundKeyword('see you then')).toBe('none');
  });

  it('requires a consent record granted by now', () => {
    expect(evaluateConsent([], null, 'sms', 'scheduling', now)).toEqual({
      allowed: false,
      reason: 'no_consent',
    });
    const future = { ...base, grantedAt: new Date('2026-03-01T00:00:00Z') };
    expect(evaluateConsent([future], null, 'sms', 'scheduling', now).allowed).toBe(false);
    expect(evaluateConsent([base], null, 'sms', 'scheduling', now).allowed).toBe(true);
  });

  it('limits message types and blocks after opt-out until re-consent', () => {
    const limited = { ...base, messageTypes: ['appointment_reminder'] as const };
    expect(evaluateConsent([limited], null, 'sms', 'billing', now)).toEqual({
      allowed: false,
      reason: 'message_type_not_consented',
    });
    const optOut = {
      practiceId: 'pr',
      recipient: patient,
      at: new Date('2026-01-15T00:00:00Z'),
      receivedOn: 'email' as const,
      keyword: 'STOP',
    };
    expect(evaluateConsent([base], optOut, 'sms', 'scheduling', now)).toEqual({
      allowed: false,
      reason: 'opted_out',
    });
    const re = { ...base, grantedAt: new Date('2026-01-20T00:00:00Z') };
    expect(evaluateConsent([base, re], optOut, 'sms', 'scheduling', now).allowed).toBe(true);
  });

  it('keys recipients distinctly', () => {
    expect(recipientKey(patient)).not.toBe(
      recipientKey({ kind: 'contact', patientId: 'p', contactId: 'c' }),
    );
  });
});

describe('10DLC status', () => {
  it('requires approved brand and campaign', () => {
    expect(canSendSms(null)).toBe(false);
    expect(canSendSms({ practiceId: 'p', brand: 'approved', campaign: 'pending' })).toBe(false);
    expect(canSendSms({ practiceId: 'p', brand: 'approved', campaign: 'approved' })).toBe(true);
  });
});
