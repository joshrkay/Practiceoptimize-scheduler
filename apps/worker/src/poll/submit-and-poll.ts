import { HttpStatusError, parseRetryAfter, PermanentJobError } from '../queue/errors.js';
import type { JsonValue } from '../queue/types.js';
import type { JobHandler, JobRunContext } from '../queue/worker.js';

/** The parts of an HTTP response the poller reads. Header names are matched case-insensitively. */
export interface PollResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: JsonValue;
}

/** Where to look for the result: a `Content-Location` URL, a result ID from the body, or both. */
export interface PollRef {
  readonly location?: string;
  readonly resultId?: string;
}

export interface PollCheckpoint {
  readonly ref: PollRef;
  /** Polls made so far (the submit is not a poll). */
  readonly polls: number;
}

export interface SubmitAndPollOptions {
  /** Starts the external operation. Pass `ctx.job.idempotencyKey` along if the API supports it. */
  submit(ctx: JobRunContext): Promise<PollResponse>;
  /** Asks for the result of an operation that answered 202. */
  poll(ref: PollRef, ctx: JobRunContext): Promise<PollResponse>;
  /** Polls before giving up (`POLL_MAX_ATTEMPTS`); the job then dead-letters with `poll_exhausted`. */
  readonly maxPolls: number;
  /** Wait between polls when the server sends no `Retry-After`. */
  readonly intervalMs: number;
  /** Ceiling on a server-requested wait. Default 10 minutes. */
  readonly maxIntervalMs?: number;
  /** Reads a result ID from a 202 body. Default: `resultId` or `id` when it is a string. */
  extractResultId?(body: JsonValue | undefined): string | undefined;
}

function header(response: PollResponse, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function defaultResultId(body: JsonValue | undefined): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const id = body['resultId'] ?? body['id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function isPollCheckpoint(value: JsonValue | null): value is PollCheckpoint & JsonValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value['polls'] === 'number';
}

/**
 * Builds a job handler for async APIs that answer 202 and are polled for the result. Each run makes one call and
 * then reschedules itself, so a worker slot is never held while waiting. 200/201 completes the job with the
 * response body as its stored result. 429 and 5xx throw for retry with backoff; other statuses fail for good.
 */
export function submitAndPoll(options: SubmitAndPollOptions): JobHandler {
  if (!Number.isInteger(options.maxPolls) || options.maxPolls < 1) throw new Error('maxPolls must be >= 1');
  const extractResultId = options.extractResultId ?? defaultResultId;
  const maxIntervalMs = options.maxIntervalMs ?? 10 * 60_000;

  return async (ctx) => {
    const previous = isPollCheckpoint(ctx.checkpoint) ? ctx.checkpoint : null;
    const response = previous ? await options.poll(previous.ref, ctx) : await options.submit(ctx);
    const polls = previous ? previous.polls + 1 : 0;
    const retryAfterMs = parseRetryAfter(header(response, 'retry-after'), ctx.now);

    if (response.status === 200 || response.status === 201) {
      return { kind: 'complete', result: response.body ?? null };
    }
    if (response.status !== 202) throw new HttpStatusError(response.status, retryAfterMs);

    const location = header(response, 'content-location') ?? previous?.ref.location;
    const resultId = extractResultId(response.body) ?? previous?.ref.resultId;
    if (location === undefined && resultId === undefined) throw new PermanentJobError('poll_no_location');
    if (polls >= options.maxPolls) throw new PermanentJobError('poll_exhausted');

    const ref: PollRef = { ...(location !== undefined && { location }), ...(resultId !== undefined && { resultId }) };
    const checkpoint: PollCheckpoint = { ref, polls };
    return {
      kind: 'reschedule',
      delayMs: Math.min(maxIntervalMs, retryAfterMs ?? options.intervalMs),
      checkpoint: checkpoint as unknown as JsonValue,
    };
  };
}
