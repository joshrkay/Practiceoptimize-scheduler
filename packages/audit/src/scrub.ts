export const REDACTED = '[REDACTED]';

export interface ScrubOptions {
  /** Exact known PHI values (for example a patient's name) to remove wherever they appear. */
  readonly knownValues?: readonly string[];
}

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Labelled values: "DOB: 1970-01-02", "member id ABC123", "MRN 00123", "patient name: Jane Q Doe"
  [/\b(dob|date of birth|birth ?date)\b(\s*[:=]?\s*)[^\s,;]+/gi, `$1$2${REDACTED}`],
  [
    /\b(member[\s_-]?id|subscriber[\s_-]?id|policy[\s_-]?(?:number|no|id)|mrn|medical record(?: number)?)\b(\s*[:=#]?\s*)[A-Za-z0-9-]+/gi,
    `$1$2${REDACTED}`,
  ],
  [
    /\b(patient(?:[\s_-]?name)?|name)\b(\s*[:=]\s*)[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}/g,
    `$1$2${REDACTED}`,
  ],
  // Unlabelled shapes
  [/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED],
  [/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g, REDACTED],
  [/\b\d{1,2}\/\d{1,2}\/(?:19|20)?\d{2}\b/g, REDACTED],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, REDACTED],
  [/(?<!\w)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, REDACTED],
];

const PHI_KEYS =
  /^(name|first_?name|last_?name|full_?name|patient_?name|dob|date_?of_?birth|birth_?date|ssn|member_?id|subscriber_?id|policy_?number|mrn|email|phone|address|street|zip)$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubText(text: string, options: ScrubOptions = {}): string {
  let out = text;
  for (const v of options.knownValues ?? []) {
    if (v.trim().length === 0) continue;
    out = out.replace(new RegExp(escapeRegExp(v), 'gi'), REDACTED);
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Deep-scrubs structured log fields, metrics labels, and trace attributes. Returns a copy. */
export function scrubValue<T>(value: T, options: ScrubOptions = {}): T {
  return walk(value, options, new WeakSet()) as T;
}

function walk(value: unknown, options: ScrubOptions, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubText(value, options);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, options, seen));
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message, options) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = PHI_KEYS.test(k) && v !== null && v !== undefined ? REDACTED : walk(v, options, seen);
  }
  return out;
}
