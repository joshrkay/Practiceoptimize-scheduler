import type { Mismatch, PostingCase, SignedOrder } from './types.js';

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Compares date, side and procedure against the signed order. Empty result means they agree. */
export function crossCheck(posting: PostingCase, order: SignedOrder): Mismatch[] {
  const out: Mismatch[] = [];
  if (posting.date !== order.date) {
    out.push({ field: 'date', posting: posting.date, order: order.date });
  }
  if (posting.laterality !== order.laterality) {
    out.push({ field: 'side', posting: posting.laterality, order: order.laterality });
  }
  if (norm(posting.procedure) !== norm(order.procedure)) {
    out.push({ field: 'procedure', posting: posting.procedure, order: order.procedure });
  }
  return out;
}
