export type PracticeId = string;

export type Channel = 'sms' | 'email' | 'portal' | 'voice';

export type MessageType =
  | 'appointment_reminder'
  | 'scheduling'
  | 'pre_op_instructions'
  | 'forms'
  | 'post_op_followup'
  | 'billing';

export type Recipient =
  | { kind: 'patient'; patientId: string }
  | { kind: 'contact'; patientId: string; contactId: string };

export interface RecipientAddresses {
  phone?: string;
  email?: string;
  portalUserId?: string;
}

/** Sender identity resolved from the case's location. */
export interface SenderIdentity {
  locationId: string;
  displayName: string;
  smsNumber?: string;
  voiceNumber?: string;
  email?: string;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function recipientKey(recipient: Recipient): string {
  return recipient.kind === 'patient'
    ? `patient:${recipient.patientId}`
    : `contact:${recipient.patientId}:${recipient.contactId}`;
}
