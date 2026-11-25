/**
 * Free text from external sources (faxes, EHR notes, payer portals, emails) is data, never instructions.
 * Tools return it wrapped as `UntrustedText`; the model only ever sees it inside a labeled, escaped block.
 */
import { z } from 'zod';

export const untrustedTextSchema = z
  .object({
    kind: z.literal('untrusted_text'),
    /** Where the text came from, e.g. `ehr:visit_note` or `fax:inbound`. */
    source: z.string().min(1),
    text: z.string(),
  })
  .strict();

export type UntrustedText = z.infer<typeof untrustedTextSchema>;

/** Wraps external free text so it is typed and labeled as untrusted. */
export function untrusted(text: string, source: string): UntrustedText {
  return { kind: 'untrusted_text', source, text };
}

export function isUntrustedText(value: unknown): value is UntrustedText {
  return untrustedTextSchema.safeParse(value).success;
}

const escapeMarkup = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Renders untrusted text for a model prompt. Markup inside the text is escaped so it cannot close the
 * block or open a new one.
 */
export function renderUntrusted(value: UntrustedText): string {
  return (
    `<untrusted_data source="${escapeMarkup(value.source)}">` +
    `${escapeMarkup(value.text)}` +
    `</untrusted_data>`
  );
}

/** Replaces every `UntrustedText` in a tool output with its rendered, labeled block. */
export function renderForModel(value: unknown): unknown {
  if (isUntrustedText(value)) return renderUntrusted(value);
  if (Array.isArray(value)) return value.map(renderForModel);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderForModel(v)]));
  }
  return value;
}

/** Serializes a tool result as the text the model receives. */
export function toModelText(value: unknown): string {
  return JSON.stringify(renderForModel(value));
}
