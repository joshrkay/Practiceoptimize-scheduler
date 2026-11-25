/** Outbound fax: provider port, cover sheet, and a fake for tests. No vendor is chosen. */

export type FaxDeliveryStatus = 'queued' | 'delivered' | 'failed';

export interface FaxMessage {
  /** Destination fax number, resolved from the verified directory by the caller. */
  readonly to: string;
  readonly coverSheet: string;
  readonly body: string;
  readonly referenceCode: string;
}

export interface FaxSendResult {
  readonly providerMessageId: string;
  readonly status: FaxDeliveryStatus;
}

export interface FaxProvider {
  send(message: FaxMessage): Promise<FaxSendResult>;
}

export const CONFIDENTIALITY_NOTICE =
  'CONFIDENTIAL: This fax contains protected health information intended only for the named recipient. ' +
  'If you received it in error, notify the sender immediately and destroy all copies. ' +
  'Any other use, disclosure or copying is prohibited.';

export interface CoverSheetInput {
  readonly senderName: string;
  readonly senderCallback: string;
  readonly recipientName: string;
  readonly subject: string;
  readonly referenceCode: string;
  readonly pageCount: number;
  readonly sentAt: Date;
}

/** Cover sheet carries our reference code and the confidentiality notice, and no patient details. */
export function buildCoverSheet(input: CoverSheetInput): string {
  return [
    'FAX COVER SHEET',
    `Date: ${input.sentAt.toISOString()}`,
    `To: ${input.recipientName}`,
    `From: ${input.senderName}`,
    `Callback: ${input.senderCallback}`,
    `Re: ${input.subject}`,
    `Pages (excluding cover): ${input.pageCount}`,
    `Reference code: ${input.referenceCode}`,
    '',
    'Please quote the reference code in any reply.',
    '',
    CONFIDENTIALITY_NOTICE,
  ].join('\n');
}

/** Records messages instead of sending them. */
export class FakeFaxProvider implements FaxProvider {
  readonly sent: FaxMessage[] = [];
  nextStatus: FaxDeliveryStatus = 'queued';
  failWith: Error | undefined;

  send(message: FaxMessage): Promise<FaxSendResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `fake-fax-${this.sent.length}`, status: this.nextStatus });
  }
}
