/**
 * Errors a job handler throws to steer retries. Messages are never stored; only `code` is, so it must not
 * contain PHI.
 */

/** An HTTP response from an external system. 429 and 5xx retry with backoff; other 4xx fail for good. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfterMs?: number) {
    super(`external call returned HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A failure that retrying cannot fix. The job moves to dead-letter and a human task is raised. */
export class PermanentJobError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'PermanentJobError';
    this.code = code;
  }
}

export interface FailureClass {
  readonly retryable: boolean;
  /** PHI-free code stored on the job. */
  readonly code: string;
  readonly retryAfterMs: number | undefined;
}

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Decides whether a thrown value should be retried. Unknown errors (network, timeouts) are retried. */
export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof HttpStatusError) {
    return {
      retryable: isRetryableStatus(error.status),
      code: `http_${error.status}`,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof PermanentJobError) {
    return { retryable: false, code: SAFE_CODE.test(error.code) ? error.code : 'permanent', retryAfterMs: undefined };
  }
  return { retryable: true, code: 'error', retryAfterMs: undefined };
}

/** Parses an HTTP `Retry-After` header (seconds or an HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(value: string | undefined | null, now: Date): number | undefined {
  if (value === undefined || value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}
