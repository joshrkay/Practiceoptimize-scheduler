import type { BookedEventSource, CaseReachedBookedEvent } from './ports.js';
import type { BillableEventStore } from './store.js';

export type MeterOutcome = 'recorded' | 'duplicate' | 'disabled';

export interface Metering {
  /** Records a billable event the first time a case reaches Booked; later transitions are no-ops. */
  recordBooked(event: CaseReachedBookedEvent): Promise<MeterOutcome>;
  /** Subscribes to the state machine; returns an unsubscribe function. */
  attach(source: BookedEventSource): () => void;
}

/** `FEATURE_METERING` defaults to false. */
export function isMeteringEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['FEATURE_METERING']?.toLowerCase() === 'true';
}

export function createMetering(deps: { store: BillableEventStore; enabled: boolean }): Metering {
  const recordBooked = async (event: CaseReachedBookedEvent): Promise<MeterOutcome> => {
    if (!deps.enabled) return 'disabled';
    for (const [name, value] of [
      ['practiceId', event.practiceId],
      ['locationId', event.locationId],
      ['caseReference', event.caseReference],
    ] as const) {
      if (!value) throw new Error(`booked event is missing ${name}`);
    }
    if (Number.isNaN(Date.parse(event.occurredAt))) {
      throw new RangeError(`invalid occurredAt ${event.occurredAt}`);
    }
    // Only de-identified fields are copied. caseType is deliberately not stored: a type change
    // must never matter, and the event carries nothing beyond what billing needs.
    const written = await deps.store.append({
      practiceId: event.practiceId,
      locationId: event.locationId,
      caseReference: event.caseReference,
      seriesId: event.seriesId ?? null,
      urgentAddOn: event.urgentAddOn,
      bookedAt: new Date(event.occurredAt).toISOString(),
    });
    return written ? 'recorded' : 'duplicate';
  };
  return {
    recordBooked,
    attach: (source) => source.onCaseReachedBooked(async (e) => void (await recordBooked(e))),
  };
}
