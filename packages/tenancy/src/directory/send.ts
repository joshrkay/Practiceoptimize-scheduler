import { createHash, randomUUID } from 'node:crypto';
import { buildCoverSheet, CONFIDENTIALITY_NOTICE, type FaxProvider } from '@scheduler/integrations-fax';
import { filterFields, REQUEST_SUBJECTS, type RequestType } from './allowlist';
import { isVerified, type Channel } from './model';
import type { DirectoryStore } from './store';
import type {
  AuditSink,
  DeliveryStatus,
  EmailProvider,
  InBasketProvider,
  ProviderResult,
  SchedulerTaskPort,
  SendAuditEvent,
} from './ports';

export interface SendDeps {
  readonly store: DirectoryStore;
  readonly fax: FaxProvider;
  readonly email: EmailProvider;
  readonly inBasket: InBasketProvider;
  readonly audit: AuditSink;
  readonly tasks: SchedulerTaskPort;
  readonly sender: { readonly name: string; readonly callback: string };
  readonly now?: () => Date;
  readonly newReferenceCode?: () => string;
}

/** The request carries a party ID, never an address. Channel and address come from the directory only. */
export interface CareTeamRequest {
  readonly practiceId: string;
  readonly partyId: string;
  readonly requestType: RequestType;
  readonly fields: Readonly<Record<string, string>>;
}

export type SendResult =
  | {
      status: 'sent';
      channel: Channel;
      referenceCode: string;
      deliveryStatus: DeliveryStatus;
      providerMessageId: string;
      droppedFields: string[];
    }
  | { status: 'needs_verification'; channel: Channel; taskId: string; referenceCode: string }
  | { status: 'party_not_found' }
  | { status: 'failed'; channel: Channel; referenceCode: string };

export function hashAddress(practiceId: string, address: string): string {
  return createHash('sha256').update(`${practiceId}\u0000${address.trim().toLowerCase()}`).digest('hex');
}

function defaultReference(): string {
  return `REF-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function sendCareTeamRequest(deps: SendDeps, req: CareTeamRequest): Promise<SendResult> {
  const now = deps.now ?? (() => new Date());
  const party = await deps.store.get(req.practiceId, req.partyId);
  if (!party) return { status: 'party_not_found' };

  const referenceCode = (deps.newReferenceCode ?? defaultReference)();
  const channel = party.preferredChannel;
  const endpoint = party.endpoints[channel];
  const audit = (e: Pick<SendAuditEvent, 'addressHash' | 'outcome' | 'deliveryStatus' | 'fieldsSent'>) =>
    deps.audit.record({
      practiceId: req.practiceId,
      partyId: req.partyId,
      requestType: req.requestType,
      channel,
      referenceCode,
      at: now().toISOString(),
      ...e,
    });

  if (!isVerified(endpoint)) {
    const { taskId } = await deps.tasks.createTask({
      practiceId: req.practiceId,
      kind: 'verify_contact',
      partyId: req.partyId,
      channel,
      reason: endpoint ? 'address not verified' : 'no address on file for preferred channel',
      referenceCode,
    });
    await audit({
      addressHash: endpoint ? hashAddress(req.practiceId, endpoint.address) : null,
      outcome: 'needs_verification',
      deliveryStatus: null,
      fieldsSent: [],
    });
    return { status: 'needs_verification', channel, taskId, referenceCode };
  }

  const { allowed, dropped } = filterFields(req.requestType, req.fields);
  const subject = REQUEST_SUBJECTS[req.requestType];
  const body = [
    subject,
    `Reference code: ${referenceCode}`,
    '',
    ...Object.entries(allowed).map(([k, v]) => `${k}: ${v}`),
  ].join('\n');
  const addressHash = hashAddress(req.practiceId, endpoint.address);
  const fieldsSent = Object.keys(allowed);

  try {
    let result: ProviderResult;
    if (channel === 'fax') {
      const coverSheet = buildCoverSheet({
        senderName: deps.sender.name,
        senderCallback: deps.sender.callback,
        recipientName: party.name,
        subject,
        referenceCode,
        pageCount: 1,
        sentAt: now(),
      });
      result = await deps.fax.send({ to: endpoint.address, coverSheet, body, referenceCode });
    } else {
      // Subject carries the reference code only; no PHI in subjects.
      const message = {
        to: endpoint.address,
        subject: `${subject} [${referenceCode}]`,
        body: `${body}\n\n${CONFIDENTIALITY_NOTICE}`,
        referenceCode,
      };
      result = channel === 'email' ? await deps.email.send(message) : await deps.inBasket.send(message);
    }
    await audit({ addressHash, outcome: 'sent', deliveryStatus: result.status, fieldsSent });
    return {
      status: 'sent',
      channel,
      referenceCode,
      deliveryStatus: result.status,
      providerMessageId: result.providerMessageId,
      droppedFields: dropped,
    };
  } catch {
    await audit({ addressHash, outcome: 'failed', deliveryStatus: 'failed', fieldsSent: [] });
    return { status: 'failed', channel, referenceCode };
  }
}
