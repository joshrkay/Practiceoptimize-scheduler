/** Default clinical terms (podiatry pilot) that must never appear in SMS or voice bodies. */
export const DEFAULT_CLINICAL_TERMS: readonly string[] = [
  'bunionectomy',
  'bunion',
  'hammertoe',
  'hammer toe',
  'plantar fasciitis',
  'plantar fascia release',
  'achilles tendon repair',
  'achilles',
  'ankle fusion',
  'arthrodesis',
  'osteotomy',
  'neuroma',
  'ingrown toenail',
  'matrixectomy',
  'tarsal tunnel',
  'charcot',
  'diabetic foot ulcer',
  'amputation',
  'debridement',
  'fracture',
  'tendon',
  'arthroscopy',
];

export interface ContentViolation {
  term: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds diagnosis or procedure names. `caseTerms` are the case's own diagnosis and procedure
 * names (and laterality-free variants) supplied by the caller, checked in addition to the defaults.
 */
export function findClinicalTerms(
  text: string,
  caseTerms: readonly string[] = [],
): ContentViolation[] {
  const found: ContentViolation[] = [];
  for (const term of [...DEFAULT_CLINICAL_TERMS, ...caseTerms]) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(text) && !found.some((f) => f.term.toLowerCase() === trimmed.toLowerCase())) {
      found.push({ term: trimmed });
    }
  }
  return found;
}
