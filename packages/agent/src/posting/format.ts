import type { PostingCase, PostingDocument, PostingFormat } from './types.js';

const list = (items: string[]): string => (items.length > 0 ? items.join(', ') : 'None');

export function missingFields(c: PostingCase): string[] {
  const missing: string[] = [];
  if (!c.date) missing.push('date');
  if (!c.startTime) missing.push('startTime');
  if (!c.procedure.trim()) missing.push('procedure');
  if (c.cpt.length === 0) missing.push('cpt');
  if (!c.laterality) missing.push('laterality');
  if (!(c.durationMinutes > 0)) missing.push('durationMinutes');
  if (!c.surgeon.trim()) missing.push('surgeon');
  if (!c.anesthesiaType.trim()) missing.push('anesthesiaType');
  return missing;
}

function fields(c: PostingCase): [string, string][] {
  return [
    ['Date', c.date],
    ['Start time', c.startTime],
    ['Procedure', c.procedure],
    ['CPT', list(c.cpt)],
    ['Laterality', c.laterality],
    ['Estimated duration (min)', String(c.durationMinutes)],
    ['Surgeon', c.surgeon],
    ['Assistant', c.assistant ?? 'None'],
    ['Anesthesia', c.anesthesiaType],
    ['Positioning', c.positioning || 'None'],
    ['Equipment', list(c.equipment)],
    ['Implants', list(c.implants)],
    ['Rep', c.rep ?? 'None'],
  ];
}

type Renderer = (c: PostingCase, heading: string) => string;

/** One renderer per facility-configured format. */
const renderers: Record<PostingFormat, Renderer> = {
  // Printed sheet (fax): one labelled line per field.
  sheet: (c, heading) =>
    [heading, '='.repeat(heading.length), ...fields(c).map(([k, v]) => `${k}: ${v}`)].join('\n'),
  // Single line for desks that key postings in from an email.
  compact: (c, heading) =>
    `${heading} | ${fields(c)
      .map(([k, v]) => `${k}=${v}`)
      .join(' | ')}`,
  // Key/value block for a person filling in a portal form.
  portal_form: (c, heading) => [heading, ...fields(c).map(([k, v]) => `[${k}] ${v}`)].join('\n'),
};

const subject = (heading: string, c: PostingCase): string =>
  `${heading}: ${c.date} ${c.startTime} (case ${c.caseId})`;

function notice(format: PostingFormat, heading: string, lines: string[]): string {
  return format === 'compact' ? `${heading} | ${lines.join(' | ')}` : [heading, ...lines].join('\n');
}

export function renderPosting(
  format: PostingFormat,
  kind: 'initial' | 'update',
  c: PostingCase,
  version: number,
): PostingDocument {
  const heading = kind === 'initial' ? 'OR POSTING REQUEST' : `OR POSTING UPDATE (revision ${version})`;
  return { format, subject: subject(heading, c), body: renderers[format](c, heading) };
}

export function renderCancellation(
  format: PostingFormat,
  c: PostingCase,
  reason: string,
  confirmationNumber?: string,
): PostingDocument {
  const heading = 'OR POSTING CANCELLATION';
  return {
    format,
    subject: subject(heading, c),
    body: notice(format, heading, [
      `Case: ${c.caseId}`,
      `Date: ${c.date}`,
      `Start time: ${c.startTime}`,
      `Procedure: ${c.procedure}`,
      `Surgeon: ${c.surgeon}`,
      `Confirmation number: ${confirmationNumber ?? 'none on file'}`,
      `Reason: ${reason}`,
    ]),
  };
}

export function renderReconfirmation(
  format: PostingFormat,
  c: PostingCase,
  confirmationNumber: string | undefined,
): PostingDocument {
  const heading = 'OR POSTING RECONFIRMATION REQUEST';
  return {
    format,
    subject: subject(heading, c),
    body: notice(format, heading, [
      `Case: ${c.caseId}`,
      `Date: ${c.date}`,
      `Start time: ${c.startTime}`,
      `Procedure: ${c.procedure}`,
      `Confirmation number: ${confirmationNumber ?? 'not yet received'}`,
      'Please reply to confirm the posting is still on the schedule.',
    ]),
  };
}
