import type { CaseRequest, SignedUrgentOrder } from './ports.js';

export type VerificationIssueCode =
  | 'order_not_found'
  | 'case_request_not_found'
  | 'case_not_ordered'
  | 'policy_block'
  | 'order_not_signed'
  | 'signed_by_other_than_surgeon'
  | 'order_not_urgent'
  | 'order_case_mismatch'
  | 'date_mismatch'
  | 'date_in_past'
  | 'side_mismatch'
  | 'procedure_mismatch';

export interface VerificationIssue {
  readonly code: VerificationIssueCode;
  readonly message: string;
}

/** Local calendar date (YYYY-MM-DD) of an instant in an IANA time zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * The checks that must pass before an urgent add-on is booked: the order is signed by its surgeon and marked
 * urgent, and the case's date, side and procedure match the signed order. Any issue blocks the booking.
 */
export function verifyUrgentOrder(order: SignedUrgentOrder, request: CaseRequest, now: Date): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (order.signature === null) {
    issues.push({ code: 'order_not_signed', message: 'The order has no surgeon signature.' });
  } else if (order.signature.signedBy !== order.surgeonId) {
    issues.push({ code: 'signed_by_other_than_surgeon', message: 'The order was not signed by the ordering surgeon.' });
  }
  if (order.urgency !== 'urgent') {
    issues.push({ code: 'order_not_urgent', message: 'The order is not marked urgent.' });
  }
  if (request.orderId !== order.orderId || request.caseId !== order.caseId || request.practiceId !== order.practiceId) {
    issues.push({ code: 'order_case_mismatch', message: 'The case does not reference this signed order.' });
  }
  if (request.date !== order.date) {
    issues.push({ code: 'date_mismatch', message: `Case date ${request.date} does not match signed order date ${order.date}.` });
  }
  if (order.date < localDate(now, order.siteOfService.timeZone)) {
    issues.push({ code: 'date_in_past', message: `Signed order date ${order.date} is in the past.` });
  }
  if (request.side !== order.side) {
    issues.push({ code: 'side_mismatch', message: `Case side ${request.side} does not match signed order side ${order.side}.` });
  }
  if (request.procedure.code !== order.procedure.code) {
    issues.push({
      code: 'procedure_mismatch',
      message: `Case procedure ${request.procedure.code} does not match signed order procedure ${order.procedure.code}.`,
    });
  }
  return issues;
}
