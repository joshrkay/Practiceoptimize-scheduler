/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week) evaluated in an IANA time zone, so a
 * practice's nightly sync runs at its local 2 a.m. across daylight-saving changes. Supports `*`, numbers, lists,
 * ranges and steps (`*\/15`, `1-5`, `0,30`). Day-of-week 0 and 7 are Sunday. When both day fields are
 * restricted, a day matches if either does (standard cron).
 */

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly any: boolean;
}

export interface CronExpression {
  readonly source: string;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

export class InvalidCronError extends Error {
  constructor(source: string, detail: string) {
    super(`invalid cron expression "${source}": ${detail}`);
    this.name = 'InvalidCronError';
  }
}

function parseField(source: string, text: string, min: number, max: number): CronField {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [rangeText, stepText] = part.split('/') as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new InvalidCronError(source, `bad step in "${part}"`);
    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+-\d+$/.test(rangeText)) {
      [lo, hi] = rangeText.split('-').map(Number) as [number, number];
    } else if (/^\d+$/.test(rangeText)) {
      lo = Number(rangeText);
      hi = stepText === undefined ? lo : max;
    } else {
      throw new InvalidCronError(source, `bad field "${part}"`);
    }
    if (lo < min || hi > max || lo > hi) throw new InvalidCronError(source, `"${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any: text === '*' };
}

export function parseCron(source: string): CronExpression {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) throw new InvalidCronError(source, 'expected 5 fields');
  const [mi, h, dom, mo, dow] = fields as [string, string, string, string, string];
  const dayOfWeek = parseField(source, dow, 0, 7);
  const normalized = new Set([...dayOfWeek.values].map((d) => (d === 7 ? 0 : d)));
  return {
    source,
    minute: parseField(source, mi, 0, 59),
    hour: parseField(source, h, 0, 23),
    dayOfMonth: parseField(source, dom, 1, 31),
    month: parseField(source, mo, 1, 12),
    dayOfWeek: { values: normalized, any: dayOfWeek.any },
  };
}

interface LocalParts {
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(at: Date, timeZone: string): LocalParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;
  return {
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    weekday: WEEKDAYS[parts['weekday'] as string] as number,
  };
}

function dayMatches(expr: CronExpression, p: LocalParts): boolean {
  const dom = expr.dayOfMonth.values.has(p.day);
  const dow = expr.dayOfWeek.values.has(p.weekday);
  if (expr.dayOfMonth.any || expr.dayOfWeek.any) return dom && dow;
  return dom || dow;
}

const MINUTE = 60_000;
const SEARCH_LIMIT_MS = 4 * 366 * 24 * 60 * MINUTE;

/**
 * The first whole minute strictly after `after` that matches, in `timeZone` (default UTC). Local times skipped
 * by a spring-forward change never fire; a fall-back hour fires on its first occurrence and its repeat.
 */
export function nextCronRun(expr: CronExpression, after: Date, timeZone = 'UTC'): Date {
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = t + SEARCH_LIMIT_MS;
  while (t < end) {
    const p = localParts(new Date(t), timeZone);
    if (!expr.month.values.has(p.month) || !dayMatches(expr, p) || !expr.hour.values.has(p.hour)) {
      // Jump to the next local hour boundary (uses the local minute, so it works for any zone offset).
      t += (60 - p.minute) * MINUTE;
      continue;
    }
    if (expr.minute.values.has(p.minute)) return new Date(t);
    t += MINUTE;
  }
  throw new InvalidCronError(expr.source, 'never matches');
}
