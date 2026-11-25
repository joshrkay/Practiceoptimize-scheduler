/**
 * Ports for billable-case metering. The case state machine is built elsewhere; metering consumes
 * "case reached Booked" as this event shape. Wire the real state machine to `BookedEventSource`
 * at integration time.
 */

/** Emitted by the case state machine every time a case transitions into Booked. */
export interface CaseReachedBookedEvent {
  practiceId: string;
  locationId: string;
  /** Opaque, de-identified case reference (never a name, MRN or other PHI). */
  caseReference: string;
  /** Present when the case belongs to a case series; each case still bills separately. */
  seriesId?: string | undefined;
  /** Signed urgent order add-on. Billable like any other case. */
  urgentAddOn: boolean;
  /** Case type at the time of this transition; changes never create a second billable event. */
  caseType: string;
  /** When the case reached Booked (ISO 8601). */
  occurredAt: string;
}

export type BookedEventHandler = (event: CaseReachedBookedEvent) => Promise<void>;

/** Subscription seam implemented by the state machine at integration. */
export interface BookedEventSource {
  onCaseReachedBooked(handler: BookedEventHandler): () => void;
}

/** In-memory source for tests. */
export class InMemoryBookedEventSource implements BookedEventSource {
  private readonly handlers = new Set<BookedEventHandler>();

  onCaseReachedBooked(handler: BookedEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(event: CaseReachedBookedEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event);
  }
}
