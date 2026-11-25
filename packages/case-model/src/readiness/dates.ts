import type { IsoDate } from './ports.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function toDayNumber(date: IsoDate): number {
  if (!ISO_DATE.test(date)) throw new Error(`Invalid ISO date: ${date}`);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  return ms / DAY_MS;
}

export function fromDayNumber(day: number): IsoDate {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** Calendar date of an ISO timestamp or date, in UTC. */
export function dateOf(value: string): IsoDate {
  return value.length === 10 ? value : new Date(value).toISOString().slice(0, 10);
}
