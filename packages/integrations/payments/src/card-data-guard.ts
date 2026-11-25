const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

/**
 * True when a payload looks like it carries a card number (13-19 digits passing the Luhn check,
 * optionally separated by spaces or dashes). Used to refuse such a payload before it is parsed,
 * stored or logged. The offending value is never returned or echoed.
 */
export function containsCardData(payload: string): boolean {
  const candidates = payload.match(/\d(?:[ -]?\d){12,18}/g) ?? [];
  return candidates.some((c) => luhn(c.replace(/[ -]/g, '')));
}
