import type { IsoDate } from './ports.js';

const toDate = (d: IsoDate): Date => new Date(`${d}T00:00:00Z`);
const toIso = (d: Date): IsoDate => d.toISOString().slice(0, 10);

export function isBusinessDay(date: IsoDate, holidays: ReadonlySet<IsoDate>): boolean {
  const dow = toDate(date).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(date);
}

/** The date `n` business days before `date` (weekends and listed holidays do not count). */
export function subtractBusinessDays(
  date: IsoDate,
  n: number,
  holidays: ReadonlySet<IsoDate>,
): IsoDate {
  const d = toDate(date);
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (isBusinessDay(toIso(d), holidays)) remaining -= 1;
  }
  return toIso(d);
}
