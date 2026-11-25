/**
 * Queue metadata (job type, idempotency key) is visible to operators, logs and metrics, so it must never carry
 * PHI. These checks only allow machine identifiers: no spaces (names), no `@` (emails), bounded length.
 */

const JOB_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
/** Digit runs that look like phone numbers, SSNs or member IDs. Build keys from UUIDs or record IDs instead. */
const LONG_DIGIT_RUN = /\d{9,}|\d{3}-\d{2}-\d{4}|\d{3}-\d{3}-\d{4}/;

export class UnsafeQueueMetadataError extends Error {
  constructor(field: string) {
    super(`${field} must be a PHI-free machine identifier`);
    this.name = 'UnsafeQueueMetadataError';
  }
}

export function assertSafeJobType(type: string): void {
  if (type.length > 100 || !JOB_TYPE.test(type)) throw new UnsafeQueueMetadataError('job type');
}

export function assertSafeIdempotencyKey(key: string): void {
  // UUIDs contain hex runs, not 9+ plain digits, so they pass; strip them before the digit-run check anyway.
  const withoutUuids = key.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
  if (key.length > 200 || !IDEMPOTENCY_KEY.test(key) || LONG_DIGIT_RUN.test(withoutUuids)) {
    throw new UnsafeQueueMetadataError('idempotency key');
  }
}
