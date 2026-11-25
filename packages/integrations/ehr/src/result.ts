import type { UnsupportedResult } from './capabilities.js';

export type EhrErrorCode =
  /** The location has no EHR source mapped for this practice. */
  | 'location_not_mapped'
  /** The requested record does not exist (or is not visible to this practice). */
  | 'not_found'
  /** The request is malformed (bad time window, missing field). */
  | 'invalid_request'
  /** Credentials are missing, rejected, or for the wrong environment. */
  | 'auth_failed'
  /** The vendor or network failed; `retryable` says whether to try again. */
  | 'upstream_error';

export interface EhrError {
  readonly status: 'error';
  readonly code: EhrErrorCode;
  readonly retryable: boolean;
  /** Safe for logs: never contains PHI or vendor response bodies. */
  readonly message: string;
}

export interface EhrOk<T> {
  readonly status: 'ok';
  readonly value: T;
}

/**
 * Every connector call returns one of three outcomes. There is no silent no-op: a capability the
 * location's EHR connection lacks comes back as `unsupported` with a workspace task for the caller.
 */
export type EhrResult<T> = EhrOk<T> | UnsupportedResult | EhrError;

export const ok = <T>(value: T): EhrOk<T> => ({ status: 'ok', value });

export const ehrError = (code: EhrErrorCode, message: string, retryable = false): EhrError => ({
  status: 'error',
  code,
  retryable,
  message,
});
