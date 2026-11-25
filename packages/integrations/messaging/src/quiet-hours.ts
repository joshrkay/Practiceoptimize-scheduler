export interface QuietHoursWindow {
  /** Minutes after local midnight when quiet hours begin (default 20:00). */
  startMinutes: number;
  /** Minutes after local midnight when quiet hours end (default 08:00). */
  endMinutes: number;
}

export const DEFAULT_QUIET_HOURS: QuietHoursWindow = { startMinutes: 20 * 60, endMinutes: 8 * 60 };

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`Invalid IANA time zone: ${timeZone}`);
    this.name = 'InvalidTimeZoneError';
  }
}

export function parseClockTime(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid HH:MM time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function quietHoursFromEnv(env: Record<string, string | undefined>): QuietHoursWindow {
  return {
    startMinutes: env.QUIET_HOURS_START
      ? parseClockTime(env.QUIET_HOURS_START)
      : DEFAULT_QUIET_HOURS.startMinutes,
    endMinutes: env.QUIET_HOURS_END
      ? parseClockTime(env.QUIET_HOURS_END)
      : DEFAULT_QUIET_HOURS.endMinutes,
  };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new InvalidTimeZoneError(timeZone);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Offset (ms) of the zone from UTC at the given instant. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Converts a local wall-clock time in a zone to a UTC instant (DST-safe). */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  const first = wall - offsetMs(new Date(wall), timeZone);
  const second = wall - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

function isQuietMinute(minutes: number, w: QuietHoursWindow): boolean {
  return w.startMinutes > w.endMinutes
    ? minutes >= w.startMinutes || minutes < w.endMinutes
    : minutes >= w.startMinutes && minutes < w.endMinutes;
}

export function isQuietHours(
  instant: Date,
  timeZone: string,
  window: QuietHoursWindow = DEFAULT_QUIET_HOURS,
): boolean {
  const p = localParts(instant, timeZone);
  return isQuietMinute(p.hour * 60 + p.minute, window);
}

/** The instant quiet hours next end; returns `instant` when it is already outside quiet hours. */
export function nextWindowOpen(
  instant: Date,
  timeZone: string,
  window: QuietHoursWindow = DEFAULT_QUIET_HOURS,
): Date {
  const p = localParts(instant, timeZone);
  const minutes = p.hour * 60 + p.minute;
  if (!isQuietMinute(minutes, window)) return instant;
  const crossesMidnight = window.startMinutes > window.endMinutes;
  const rollToNextDay = crossesMidnight && minutes >= window.startMinutes;
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + (rollToNextDay ? 1 : 0)));
  return zonedWallTimeToUtc(
    base.getUTCFullYear(),
    base.getUTCMonth() + 1,
    base.getUTCDate(),
    window.endMinutes,
    timeZone,
  );
}
