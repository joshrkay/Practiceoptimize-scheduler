import type { ClassifierResult, ReplyClass, ReplyClassifier } from './ports.js';

export const CLASSIFIER_MIN_CONFIDENCE = 0.7;

export type ClassificationSource = 'rules' | 'classifier' | 'keypress' | 'fallback';

export interface Classification {
  label: ReplyClass;
  source: ClassificationSource;
}

/** Lowercase, strip accents and apostrophes, collapse punctuation to single spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Urgent is deliberately broad (English and Spanish): any clinical or self-harm wording escalates.
const URGENT_PATTERNS: RegExp[] = [
  /\bchest (pain|pressure|tight)/,
  /\b(cant|cannot|can not|unable to|trouble|difficulty|hard to|dont) breath/,
  /\bshort(ness)? of breath/,
  /\b911\b/,
  /\bemergenc/,
  /\bbleed/,
  /\bfever\b/,
  /\bfaint/,
  /\bpass(ed)? out\b/,
  /\bseizure/,
  /\bstroke\b/,
  /\bnumb/,
  /\bpus\b/,
  /\bswoll?en\b|\bswelling\b/,
  /\binfect/,
  /\bpain\b|\bsymptom|\bunbearable\b/,
  /\bsuicid/,
  /\bkill (myself|me)\b/,
  /\bend (my life|it all)\b/,
  /\bhurt(ing)? myself\b|\bself ?harm/,
  /\bwant to die\b|\bdont want to live\b/,
  /\boverdos/,
  /\bdolor\b/,
  /\bno puedo respirar\b|\bfalta de aire\b|\bdificultad (para|al) respirar\b/,
  /\bsangr/,
  /\bfiebre\b/,
  /\bdesmay/,
  /\bquiero morir\b|\bmatarme\b|\bhacerme dano\b|\blastimarme\b|\bno quiero vivir\b/,
  /\bhinchaz|\bhinchad/,
  /\bentumec/,
  /\bsintoma/,
];

const STOP_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'end', 'quit', 'optout', 'parar', 'alto', 'detener', 'baja',
]);

/** Short messages that start with one of these ("stop texting me") also opt out. */
const STOP_PREFIXES = new Set(['stop', 'stopall', 'unsubscribe', 'parar', 'detener']);

const CONFIRM_CORE = new Set([
  'yes', 'y', 'yep', 'yeah', 'yup', 'confirm', 'confirmed', 'ok', 'okay', 'si', 'confirmo', 'confirmado',
  'claro', 'correct',
]);
const CONFIRM_FILLER = new Set([
  'thanks', 'thank', 'you', 'gracias', 'please', 'por', 'favor', 'see', 'there', 'will', 'be',
]);

const HELP_WORDS = new Set(['help', 'ayuda', 'info']);

const CHANGE_PATTERNS: RegExp[] = [
  /\bchange\b/, /\breschedul/, /\bpostpone/, /\bcancel\b/,
  /\b(different|another|other|new) (day|date|time)\b/,
  /\bcant make it\b/, /\bcannot make it\b/, /\bnot available\b/,
  /\bcambiar\b/, /\bcambio\b/, /\breprogram/, /\bcancelar\b/, /\botro (dia|horario|fecha)\b/, /\bno puedo ir\b/,
];

export function isUrgentText(normalized: string): boolean {
  return URGENT_PATTERNS.some((p) => p.test(normalized));
}

/** Deterministic rules. Returns null when the rules do not settle the message. Urgent wins over everything. */
export function classifyByRules(text: string): ReplyClass | null {
  const n = normalizeText(text);
  if (n === '') return null;
  if (isUrgentText(n)) return 'urgent';

  const tokens = n.split(' ');
  if (STOP_WORDS.has(n) || (tokens.length <= 3 && STOP_PREFIXES.has(tokens[0] as string))) return 'stop';
  if (CHANGE_PATTERNS.some((p) => p.test(n))) return 'change_request';
  if (HELP_WORDS.has(n)) return 'help';
  if (
    tokens.length <= 6 &&
    tokens.some((t) => CONFIRM_CORE.has(t)) &&
    tokens.every((t) => CONFIRM_CORE.has(t) || CONFIRM_FILLER.has(t))
  ) {
    return 'confirm';
  }
  return null;
}

/** Voice reminder keypresses are handled like the matching text reply: 1 confirm, 2 reach the office. */
export function classifyKeypress(digits: string): ReplyClass {
  if (digits === '1') return 'confirm';
  if (digits === '2') return 'help';
  return 'other';
}

const LABELS: ReadonlySet<string> = new Set<ReplyClass>([
  'confirm', 'change_request', 'stop', 'help', 'urgent', 'other',
]);

function validate(result: ClassifierResult): ReplyClass | null {
  if (typeof result?.label !== 'string' || !LABELS.has(result.label)) return null;
  if (typeof result.confidence !== 'number' || !(result.confidence >= CLASSIFIER_MIN_CONFIDENCE)) return null;
  return result.label as ReplyClass;
}

/**
 * Rules first, then the classifier. Never throws. When in doubt (classifier error, malformed output, low
 * confidence) the result is urgent, so the urgent path cannot be skipped by a classifier failure. Text
 * is untrusted: only the validated label is used, and a classifier-only confirm is downgraded to other so
 * crafted text cannot mark a case confirmed.
 */
export async function classifyReply(text: string, classifier: ReplyClassifier): Promise<Classification> {
  const byRules = classifyByRules(text);
  if (byRules) return { label: byRules, source: 'rules' };
  let label: ReplyClass | null;
  try {
    label = validate(await classifier.classify(text));
  } catch {
    label = null;
  }
  if (label === null) return { label: 'urgent', source: 'fallback' };
  if (label === 'confirm') label = 'other';
  return { label, source: 'classifier' };
}
