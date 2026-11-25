/** Immutable audit log, PHI scrubbing. */
export const packageName = '@scheduler/audit';

export type {
  ActorType,
  AuditActor,
  AuditEvent,
  AuditEventInput,
  AuditResult,
  AuditSink,
  AuditTarget,
} from './types.js';
export {
  AuditWriteError,
  DEFAULT_AUDIT_RETENTION_YEARS,
  auditRetentionYears,
  buildAuditEvent,
  hashInputs,
  recordAudit,
  withAudit,
} from './log.js';
export type { AuditBase } from './log.js';
export { InMemoryAuditSink } from './memory.js';
export { PgAuditSink } from './pg-sink.js';
export type { Queryable } from './pg-sink.js';
export { REDACTED, scrubText, scrubValue } from './scrub.js';
export type { ScrubOptions } from './scrub.js';
