/**
 * Reminder ladder for unanswered coordination requests.
 *
 * Counting from when the request was sent:
 *   COORD_REMIND_1_HOURS (48): first reminder through the request's own channel.
 *   COORD_REMIND_2_HOURS (96): second reminder through the same channel, and a phone task for the scheduler.
 * Separately, a request still active at its due date is marked overdue.
 *
 * The functions here are pure; time comes from the caller's injected clock.
 */
import type { CoordinationRequest } from './requests.js';
import { isActive } from './requests.js';

export interface CoordinationConfig {
  /** FEATURE_CARE_TEAM_COORDINATION; false unless set to `true`. */
  enabled: boolean;
  remind1Hours: number;
  remind2Hours: number;
}

export const DEFAULT_REMIND_1_HOURS = 48;
export const DEFAULT_REMIND_2_HOURS = 96;

function readHours(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of hours, got "${raw}"`);
  }
  return value;
}

export function loadCoordinationConfig(env: Record<string, string | undefined>): CoordinationConfig {
  const remind1Hours = readHours(env, 'COORD_REMIND_1_HOURS', DEFAULT_REMIND_1_HOURS);
  const remind2Hours = readHours(env, 'COORD_REMIND_2_HOURS', DEFAULT_REMIND_2_HOURS);
  if (remind2Hours <= remind1Hours) {
    throw new Error('COORD_REMIND_2_HOURS must be greater than COORD_REMIND_1_HOURS');
  }
  return { enabled: env.FEATURE_CARE_TEAM_COORDINATION === 'true', remind1Hours, remind2Hours };
}

export type EscalationAction =
  | { kind: 'reminder'; level: 1 | 2 }
  | { kind: 'phone_task' }
  | { kind: 'mark_overdue' };

const HOUR_MS = 60 * 60 * 1000;

/**
 * What is due for `request` at `now`. A sweep that runs late sends one reminder, not a burst:
 * past the second rung it sends reminder 2 only.
 */
export function evaluateEscalation(
  request: CoordinationRequest,
  config: Pick<CoordinationConfig, 'remind1Hours' | 'remind2Hours'>,
  now: Date,
): EscalationAction[] {
  if (!isActive(request) || request.sentAt === null) return [];
  const actions: EscalationAction[] = [];
  const elapsedHours = (now.getTime() - new Date(request.sentAt).getTime()) / HOUR_MS;

  if (elapsedHours >= config.remind2Hours) {
    if (request.remindersSent < 2) actions.push({ kind: 'reminder', level: 2 });
    if (request.phoneTaskId === null) actions.push({ kind: 'phone_task' });
  } else if (elapsedHours >= config.remind1Hours && request.remindersSent < 1) {
    actions.push({ kind: 'reminder', level: 1 });
  }

  if (request.status === 'open' && now.getTime() >= new Date(request.dueAt).getTime()) {
    actions.push({ kind: 'mark_overdue' });
  }
  return actions;
}

/** The next time `evaluateEscalation` would return something for this request, or null if never. */
export function nextEscalationAt(
  request: CoordinationRequest,
  config: Pick<CoordinationConfig, 'remind1Hours' | 'remind2Hours'>,
): Date | null {
  if (!isActive(request) || request.sentAt === null) return null;
  const sent = new Date(request.sentAt).getTime();
  const candidates: number[] = [];
  if (request.remindersSent < 1) candidates.push(sent + config.remind1Hours * HOUR_MS);
  if (request.remindersSent < 2 || request.phoneTaskId === null) {
    candidates.push(sent + config.remind2Hours * HOUR_MS);
  }
  if (request.status === 'open') candidates.push(new Date(request.dueAt).getTime());
  return candidates.length === 0 ? null : new Date(Math.min(...candidates));
}
