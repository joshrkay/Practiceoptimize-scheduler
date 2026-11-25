import type { AuditSink, CaseAuditEvent } from './ports.js';

/** In-memory `AuditSink` for tests and local wiring. */
export class InMemoryAuditSink implements AuditSink {
  readonly events: CaseAuditEvent[] = [];

  async record(event: CaseAuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}
