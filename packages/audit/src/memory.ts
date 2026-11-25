import type { AuditEvent, AuditSink } from './types.js';

/** In-memory sink for tests in other packages. Exposes read access only. */
export class InMemoryAuditSink implements AuditSink {
  private readonly store: AuditEvent[] = [];
  private failure: Error | null = null;

  append(event: AuditEvent): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.store.push(event);
    return Promise.resolve();
  }

  get events(): readonly AuditEvent[] {
    return [...this.store];
  }

  /** Test hook: make every following append reject (pass null to recover). */
  failWith(error: Error | null): void {
    this.failure = error;
  }
}
