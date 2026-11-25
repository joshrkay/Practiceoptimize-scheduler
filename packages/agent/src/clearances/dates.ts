import type { IsoDate } from './ports.js';

const MS_PER_DAY = 86_400_000;

export function toDate(d: IsoDate): number {
  return Date.parse(`${d}T00:00:00Z`);
}

export function addDays(d: IsoDate, days: number): IsoDate {
  return new Date(toDate(d) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function today(now: Date): IsoDate {
  return now.toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toDate(to) - toDate(from)) / MS_PER_DAY);
}
