/**
 * Field checks for practice data. They run before anything is written so a bad NPI, TIN or time zone is
 * rejected with a clear message instead of a database constraint error.
 */

const US_STATE_CODES = new Set(
  (
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND ' +
    'OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'
  ).split(' '),
);

/**
 * NPI check digit: Luhn over the first nine digits prefixed with the card issuer prefix 80840
 * (CMS NPI standard). Synthetic fixtures must use NPIs that pass this check.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    // Double every second digit counting from the right of the payload (the check digit is excluded).
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

/** Nine-digit taxpayer identification number (EIN), digits only. */
export function isValidTin(tin: string): boolean {
  return /^\d{9}$/.test(tin) && !tin.startsWith('00');
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isUsStateCode(state: string): boolean {
  return US_STATE_CODES.has(state);
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function isLocalTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Thrown when practice data fails validation. `issues` lists every problem found. */
export class PracticeDataError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid practice data: ${issues.join('; ')}`);
    this.name = 'PracticeDataError';
  }
}

/** Collects problems and throws them together. */
export class Checker {
  private readonly issues: string[] = [];

  check(ok: boolean, message: string): this {
    if (!ok) this.issues.push(message);
    return this;
  }

  throwIfInvalid(): void {
    if (this.issues.length > 0) throw new PracticeDataError(this.issues);
  }
}
