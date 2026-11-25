import type { AscChannelPort, AscDirectoryPort, SignedUrgentOrder } from './ports.js';

export type AscCallReason = 'no_electronic_channel' | 'submission_failed' | 'no_confirmation' | 'rejected' | 'facility_unknown';

export interface AscCallTask {
  readonly kind: 'call_task';
  readonly reason: AscCallReason;
  readonly facilityName: string | null;
  readonly phoneNumber: string | null;
  readonly detail: string;
}

export type AscSubmitOutcome =
  | { readonly kind: 'submitted'; readonly submissionId: string; readonly confirmBy: Date }
  | AscCallTask;

export type AscCheckOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'confirmed'; readonly start: string; readonly confirmationNumber: string }
  | AscCallTask;

function ascSite(order: SignedUrgentOrder): string {
  if (order.siteOfService.kind !== 'asc') throw new Error('ASC add-on requires an ASC site of service');
  return order.siteOfService.facilityId;
}

/**
 * Submits the add-on through the ASC's electronic channel. With no channel, or when submission fails, returns a
 * call task (with the ASC's phone number) instead. The ASC has `timeoutMinutes` to confirm.
 */
export async function submitAscAddOn(
  directory: AscDirectoryPort,
  channel: AscChannelPort,
  order: SignedUrgentOrder,
  now: Date,
  timeoutMinutes: number,
): Promise<AscSubmitOutcome> {
  const facilityId = ascSite(order);
  const facility = await directory.getFacility(order.practiceId, facilityId);
  if (facility === null) {
    return { kind: 'call_task', reason: 'facility_unknown', facilityName: null, phoneNumber: null, detail: `ASC ${facilityId} is not in the practice's facility directory.` };
  }
  const call = (reason: AscCallReason, detail: string): AscCallTask => ({
    kind: 'call_task',
    reason,
    facilityName: facility.name,
    phoneNumber: facility.phoneNumber,
    detail,
  });
  if (!facility.hasElectronicChannel) {
    return call('no_electronic_channel', `${facility.name} has no electronic add-on channel.`);
  }
  try {
    const { submissionId } = await channel.submitAddOn({
      practiceId: order.practiceId,
      facilityId,
      caseId: order.caseId,
      patientId: order.patientId,
      surgeonId: order.surgeonId,
      procedure: order.procedure,
      side: order.side,
      date: order.date,
      durationMinutes: order.durationMinutes,
    });
    return { kind: 'submitted', submissionId, confirmBy: new Date(now.getTime() + timeoutMinutes * 60_000) };
  } catch {
    return call('submission_failed', `Electronic add-on submission to ${facility.name} failed.`);
  }
}

/** Checks a submitted add-on. Past the confirm-by time with no confirmation, returns a call task. */
export async function checkAscAddOn(
  directory: AscDirectoryPort,
  channel: AscChannelPort,
  order: SignedUrgentOrder,
  submissionId: string,
  confirmBy: Date,
  now: Date,
): Promise<AscCheckOutcome> {
  const facilityId = ascSite(order);
  const status = await channel.getStatus(order.practiceId, submissionId);
  if (status.status === 'confirmed') {
    return { kind: 'confirmed', start: status.start, confirmationNumber: status.confirmationNumber };
  }
  if (status.status === 'pending' && now.getTime() < confirmBy.getTime()) {
    return { kind: 'pending' };
  }
  const facility = await directory.getFacility(order.practiceId, facilityId);
  const name = facility?.name ?? facilityId;
  return {
    kind: 'call_task',
    reason: status.status === 'rejected' ? 'rejected' : 'no_confirmation',
    facilityName: facility?.name ?? null,
    phoneNumber: facility?.phoneNumber ?? null,
    detail:
      status.status === 'rejected'
        ? `${name} rejected the electronic add-on: ${status.reason}`
        : `${name} did not confirm the electronic add-on by ${confirmBy.toISOString()}.`,
  };
}
