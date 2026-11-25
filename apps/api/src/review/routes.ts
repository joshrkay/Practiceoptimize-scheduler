import type { review } from '@scheduler/agent';

type Queue = InstanceType<typeof review.ReviewQueue>;
type Item = review.ReviewItem;

/** Authenticated session. The practice and user come only from here, never from a request body. */
export interface Session {
  readonly practiceId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

export interface ReviewRequest {
  readonly session: Session | undefined;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface ReviewResponse {
  readonly status: number;
  readonly body: unknown;
}

export type Handler = (req: ReviewRequest) => Promise<ReviewResponse>;

const ALLOWED_ROLES = ['scheduler', 'practice_admin'];
const STATUSES = ['pending', 'executing', 'approved', 'edited_approved', 'rejected', 'expired', 'failed'];

const error = (status: number, code: string, message: string): ReviewResponse => ({
  status,
  body: { error: { code, message } },
});

const present = (item: Item) => ({
  id: item.id,
  caseId: item.caseId,
  actionType: item.actionType,
  inputs: item.inputs,
  reason: item.reason,
  evidenceLinks: item.evidenceLinks,
  policyResult: item.policyResult,
  status: item.status,
  createdAt: item.createdAt.toISOString(),
  expiresAt: item.expiresAt.toISOString(),
  ...(item.decidedBy !== undefined ? { decidedBy: item.decidedBy } : {}),
  ...(item.decidedAt ? { decidedAt: item.decidedAt.toISOString() } : {}),
  ...(item.rejectionReason !== undefined ? { rejectionReason: item.rejectionReason } : {}),
  ...(item.diff ? { diff: item.diff } : {}),
});

const FAILURE_STATUS: Record<review.DecisionFailure['code'], number> = {
  not_found: 404,
  not_pending: 409,
  expired: 409,
  hard_rule_failed: 422,
  execution_failed: 502,
  invalid: 400,
};

const failure = (f: review.DecisionFailure): ReviewResponse => ({
  status: FAILURE_STATUS[f.code],
  body: { error: { code: f.code, message: f.message }, ...(f.item ? { item: present(f.item) } : {}) },
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Wraps a handler with the authentication and role checks every review route needs. */
function guarded(fn: (session: Session, req: ReviewRequest) => Promise<ReviewResponse>): Handler {
  return async (req) => {
    const { session } = req;
    if (!session) return error(401, 'unauthenticated', 'Sign in required.');
    if (!session.roles.some((r) => ALLOWED_ROLES.includes(r))) {
      return error(403, 'forbidden', 'Scheduler or practice admin role required.');
    }
    return fn(session, req);
  };
}

export interface ReviewHandlers {
  readonly list: Handler;
  readonly approve: Handler;
  readonly editAndApprove: Handler;
  readonly reject: Handler;
  readonly bulkApprove: Handler;
  readonly takeOver: Handler;
  readonly release: Handler;
}

/** Framework-free handlers; mount each on its route once a web framework is chosen. */
export function createReviewHandlers(queue: Queue): ReviewHandlers {
  const actorOf = (s: Session) => ({ practiceId: s.practiceId, userId: s.userId });
  const itemId = (req: ReviewRequest) => req.params?.['itemId'];
  const caseId = (req: ReviewRequest) => req.params?.['caseId'];
  const missing = (what: string) => error(400, 'invalid', `${what} is required.`);

  return {
    // GET /review/items?status=&caseId=
    list: guarded(async (s, req) => {
      const status = req.query?.['status'];
      if (status !== undefined && !STATUSES.includes(status)) return error(400, 'invalid', 'Unknown status.');
      const case_ = req.query?.['caseId'];
      const items = await queue.list(s.practiceId, {
        ...(status !== undefined ? { status: status as review.ReviewStatus } : {}),
        ...(case_ !== undefined ? { caseId: case_ } : {}),
      });
      return { status: 200, body: { items: items.map(present) } };
    }),

    // POST /review/items/:itemId/approve
    approve: guarded(async (s, req) => {
      const id = itemId(req);
      if (!id) return missing('itemId');
      const r = await queue.approve(actorOf(s), id);
      return r.ok ? { status: 200, body: { item: present(r.item) } } : failure(r);
    }),

    // POST /review/items/:itemId/edit-and-approve   body: { inputs: {...} }
    editAndApprove: guarded(async (s, req) => {
      const id = itemId(req);
      if (!id) return missing('itemId');
      if (!isObject(req.body) || !isObject(req.body['inputs'])) return missing('inputs');
      const r = await queue.editAndApprove(actorOf(s), id, req.body['inputs']);
      return r.ok ? { status: 200, body: { item: present(r.item) } } : failure(r);
    }),

    // POST /review/items/:itemId/reject   body: { reason: string }
    reject: guarded(async (s, req) => {
      const id = itemId(req);
      if (!id) return missing('itemId');
      const reason = isObject(req.body) ? req.body['reason'] : undefined;
      if (typeof reason !== 'string' || reason.trim() === '') return missing('reason');
      const r = await queue.reject(actorOf(s), id, reason);
      return r.ok ? { status: 200, body: { item: present(r.item) } } : failure(r);
    }),

    // POST /review/bulk-approve   body: { actionType: string, itemIds: string[] }
    bulkApprove: guarded(async (s, req) => {
      const body = req.body;
      if (!isObject(body) || typeof body['actionType'] !== 'string') return missing('actionType');
      const ids = body['itemIds'];
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === 'string')) {
        return missing('itemIds');
      }
      const r = await queue.bulkApprove(actorOf(s), body['actionType'], ids as string[]);
      if ('ok' in r) return failure(r);
      return { status: 200, body: { approved: r.approved.map(present), dropped: r.dropped } };
    }),

    // POST /review/cases/:caseId/take-over
    takeOver: guarded(async (s, req) => {
      const id = caseId(req);
      if (!id) return missing('caseId');
      const r = await queue.takeOver(actorOf(s), id);
      return r.ok
        ? { status: 200, body: { caseId: id, takenOverBy: r.takeover.userId, since: r.takeover.since.toISOString() } }
        : error(409, 'already_taken_over', r.message);
    }),

    // POST /review/cases/:caseId/release
    release: guarded(async (s, req) => {
      const id = caseId(req);
      if (!id) return missing('caseId');
      const r = await queue.release(actorOf(s), id);
      return r.ok ? { status: 200, body: { caseId: id, released: true } } : error(409, 'not_taken_over', r.message ?? '');
    }),
  };
}
