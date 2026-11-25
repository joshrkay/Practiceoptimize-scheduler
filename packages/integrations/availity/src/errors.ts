import type { PracticeId } from './ports.js';

export abstract class AvailityError extends Error {
  abstract readonly kind: string;
  /** True when the job queue should retry with backoff. */
  readonly retryable: boolean = false;
}

interface ResponseContext {
  practiceId: PracticeId;
  status: number;
  transactionId: string | null;
}

/** 401 or missing/expired token: the practice must reconnect. Its Availity jobs are paused. */
export class ReconnectRequiredError extends AvailityError {
  readonly kind = 'reconnect_required';
  constructor(
    readonly practiceId: PracticeId,
    readonly status: number,
    readonly transactionId: string | null,
  ) {
    super('Availity connection must be reconnected by the practice admin');
  }
}

/** 403: the practice lacks permission or enrollment for this API. Not retryable. */
export class PermissionOrEnrollmentError extends AvailityError {
  readonly kind = 'permission_or_enrollment';
  readonly practiceId: PracticeId;
  readonly status: number;
  readonly transactionId: string | null;
  constructor(ctx: ResponseContext) {
    super('Availity denied access: permission or enrollment issue');
    this.practiceId = ctx.practiceId;
    this.status = ctx.status;
    this.transactionId = ctx.transactionId;
  }
}

/** 429, 5xx, or a network failure: retry with backoff through the job queue. */
export class RetryableError extends AvailityError {
  readonly kind = 'retryable';
  override readonly retryable = true;
  readonly practiceId: PracticeId;
  readonly status: number;
  readonly transactionId: string | null;
  readonly retryAfterMs: number | null;
  constructor(ctx: ResponseContext & { retryAfterMs: number | null }) {
    super(ctx.status === 0 ? 'Availity request failed before a response' : `Availity returned ${ctx.status}`);
    this.practiceId = ctx.practiceId;
    this.status = ctx.status;
    this.transactionId = ctx.transactionId;
    this.retryAfterMs = ctx.retryAfterMs;
  }
}

/** Any other non-2xx status. Not retryable. The response body is deliberately not retained (may hold PHI). */
export class AvailityRequestError extends AvailityError {
  readonly kind = 'request_failed';
  readonly practiceId: PracticeId;
  readonly status: number;
  readonly transactionId: string | null;
  constructor(ctx: ResponseContext) {
    super(`Availity returned ${ctx.status}`);
    this.practiceId = ctx.practiceId;
    this.status = ctx.status;
    this.transactionId = ctx.transactionId;
  }
}

/** The client refused the request before sending it (endpoint not allowed, caller-supplied credentials). */
export class RequestRefusedError extends AvailityError {
  readonly kind = 'request_refused';
}

export class AvailityConfigError extends AvailityError {
  readonly kind = 'config';
}
