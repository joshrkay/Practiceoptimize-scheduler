import type { SenderIdentity } from './types.js';

export const AUTOMATED_DISCLOSURE = 'automated assistant';

export function hasAutomatedDisclosure(text: string): boolean {
  return text.toLowerCase().includes(AUTOMATED_DISCLOSURE);
}

export interface ComposedMessage {
  from: string;
  subject?: string;
  body: string;
}

export class MissingSenderError extends Error {
  constructor(channel: string, locationId: string) {
    super(`Location ${locationId} has no sender for channel ${channel}`);
    this.name = 'MissingSenderError';
  }
}

/** SMS: sent from the location's number. */
export function composeSms(identity: SenderIdentity, body: string): ComposedMessage {
  if (!identity.smsNumber) throw new MissingSenderError('sms', identity.locationId);
  return {
    from: identity.smsNumber,
    body: `${identity.displayName}: ${body} (Automated assistant message. Reply STOP to opt out.)`,
  };
}

/** Email: sent from the location's address. */
export function composeEmail(
  identity: SenderIdentity,
  subject: string,
  body: string,
): ComposedMessage {
  if (!identity.email) throw new MissingSenderError('email', identity.locationId);
  return {
    from: identity.email,
    subject: `${identity.displayName}: ${subject}`,
    body: `${body}\n\nThis message was sent by the ${identity.displayName} automated assistant. Reply STOP to opt out of automated messages.`,
  };
}

/** Portal: posted under the location's display name. */
export function composePortal(
  identity: SenderIdentity,
  subject: string,
  body: string,
): ComposedMessage {
  return {
    from: identity.displayName,
    subject,
    body: `${body}\n\nThis message was sent by the ${identity.displayName} automated assistant.`,
  };
}

/** Voice: one-way automated call that reads the message and accepts a keypress. */
export function composeVoice(identity: SenderIdentity, body: string): ComposedMessage {
  if (!identity.voiceNumber) throw new MissingSenderError('voice', identity.locationId);
  return {
    from: identity.voiceNumber,
    body: `This is an automated assistant calling from ${identity.displayName}. ${body} Press 1 to confirm. Press 2 to reach the office. To stop automated calls, call the office.`,
  };
}

export type VoiceKeypressAction = 'confirm' | 'reach_office' | 'unrecognized';

export function interpretVoiceKeypress(digit: string): VoiceKeypressAction {
  if (digit === '1') return 'confirm';
  if (digit === '2') return 'reach_office';
  return 'unrecognized';
}
