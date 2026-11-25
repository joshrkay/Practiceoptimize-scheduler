import type { BillableEventStore } from './store.js';
import type { BillableEvent } from './types.js';

export class InMemoryBillableEventStore implements BillableEventStore {
  private readonly events = new Map<string, BillableEvent>();

  append(event: BillableEvent): Promise<boolean> {
    const key = `${event.practiceId}\u0000${event.caseReference}`;
    if (this.events.has(key)) return Promise.resolve(false);
    this.events.set(key, Object.freeze({ ...event }));
    return Promise.resolve(true);
  }

  listForPractice(
    practiceId: string,
    startInclusive: string,
    endExclusive: string,
  ): Promise<BillableEvent[]> {
    const start = Date.parse(startInclusive);
    const end = Date.parse(endExclusive);
    const rows = [...this.events.values()]
      .filter((e) => e.practiceId === practiceId)
      .filter((e) => Date.parse(e.bookedAt) >= start && Date.parse(e.bookedAt) < end)
      .sort(
        (a, b) =>
          Date.parse(a.bookedAt) - Date.parse(b.bookedAt) ||
          a.caseReference.localeCompare(b.caseReference),
      );
    return Promise.resolve(rows.map((e) => ({ ...e })));
  }
}
