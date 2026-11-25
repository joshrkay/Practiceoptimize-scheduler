/** Worker settings read from the environment. None of these are secrets. */

export interface WorkerConfig {
  /** Jobs one practice may have running at once, across the whole fleet (per claim). */
  readonly maxConcurrencyPerPractice: number;
  /** Polls a submit-and-poll job makes before it gives up and creates a human task. */
  readonly pollMaxAttempts: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  maxConcurrencyPerPractice: 2,
  pollMaxAttempts: 20,
};

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

/**
 * Reads `QUEUE_MAX_CONCURRENCY_PER_PRACTICE` (issue name `QUEUE_MAX_CONCURRENCY_PER_TENANT` is accepted as an
 * alias) and `POLL_MAX_ATTEMPTS`.
 */
export function readWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const concurrencyName =
    env['QUEUE_MAX_CONCURRENCY_PER_PRACTICE'] !== undefined
      ? 'QUEUE_MAX_CONCURRENCY_PER_PRACTICE'
      : 'QUEUE_MAX_CONCURRENCY_PER_TENANT';
  return {
    maxConcurrencyPerPractice: positiveInt(
      concurrencyName,
      env[concurrencyName],
      DEFAULT_WORKER_CONFIG.maxConcurrencyPerPractice,
    ),
    pollMaxAttempts: positiveInt('POLL_MAX_ATTEMPTS', env['POLL_MAX_ATTEMPTS'], DEFAULT_WORKER_CONFIG.pollMaxAttempts),
  };
}
