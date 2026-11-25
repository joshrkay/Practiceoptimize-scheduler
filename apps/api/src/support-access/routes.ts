import type { SupportAccessService } from './service.js';
import {
  SupportAccessError,
  type AccessLogFilter,
  type SessionContext,
  type SupportAuditEvent,
  type SupportGrant,
} from './types.js';

/**
 * Framework-free handlers: typed request in, typed response out. The caller identity
 * (user and practice) comes only from `session`; bodies never carry it. The one
 * exception is `practiceId` on support-engineer requests, which names the target
 * practice because internal sessions belong to no practice.
 */
export interface ApiRequest {
  readonly session: SessionContext | null;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export type ApiResponse<T> =
  | { readonly status: 200 | 201; readonly body: T }
  | { readonly status: 400 | 401 | 403 | 404 | 409 | 500; readonly body: { readonly error: string; readonly message: string } };

type Handler<T> = (req: ApiRequest) => Promise<ApiResponse<T>>;

const STATUS = { invalid_request: 400, forbidden: 403, not_found: 404, conflict: 409 } as const;

function fail(error: unknown): ApiResponse<never> {
  if (error instanceof SupportAccessError) {
    return { status: STATUS[error.code], body: { error: error.code, message: error.message } };
  }
  return { status: 500, body: { error: 'internal', message: 'unexpected error' } };
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new SupportAccessError('invalid_request', 'JSON object body required');
  }
  return body as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new SupportAccessError('invalid_request', `${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new SupportAccessError('invalid_request', `${key} must be a string`);
  return v;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number') throw new SupportAccessError('invalid_request', `${key} must be a number`);
  return v;
}

function param(req: ApiRequest, key: string): string {
  const v = req.params?.[key];
  if (!v) throw new SupportAccessError('invalid_request', `${key} is required`);
  return v;
}

export interface SupportAccessRoutes {
  requestGrant: Handler<SupportGrant>;
  approveGrant: Handler<SupportGrant>;
  denyGrant: Handler<SupportGrant>;
  revokeGrant: Handler<SupportGrant>;
  listGrants: Handler<{ grants: readonly SupportGrant[] }>;
  openSession: Handler<{ sessionId: string; expiresAt: string }>;
  recordAccess: Handler<{ grantId: string | null }>;
  accessLog: Handler<{ events: readonly SupportAuditEvent[] }>;
  requestBreakGlass: Handler<SupportGrant>;
  approveBreakGlass: Handler<SupportGrant>;
}

export function createSupportAccessRoutes(service: SupportAccessService): SupportAccessRoutes {
  function route<T>(
    okStatus: 200 | 201,
    run: (session: SessionContext, req: ApiRequest) => Promise<T>,
  ): Handler<T> {
    return async (req) => {
      if (!req.session) {
        return { status: 401, body: { error: 'unauthenticated', message: 'session required' } };
      }
      try {
        return { status: okStatus, body: await run(req.session, req) };
      } catch (error) {
        return fail(error);
      }
    };
  }

  return {
    requestGrant: route(201, (s, req) => {
      const b = bodyObject(req.body);
      return service.requestGrant(s, {
        practiceId: str(b, 'practiceId', true) as string,
        caseId: str(b, 'caseId', false),
        reason: str(b, 'reason', true) as string,
        durationHours: num(b, 'durationHours'),
      });
    }),
    approveGrant: route(200, (s, req) => service.approveGrant(s, param(req, 'grantId'))),
    denyGrant: route(200, (s, req) =>
      service.denyGrant(s, param(req, 'grantId'), str(bodyObject(req.body ?? {}), 'reason', false)),
    ),
    revokeGrant: route(200, (s, req) =>
      service.revokeGrant(s, param(req, 'grantId'), str(bodyObject(req.body ?? {}), 'reason', false)),
    ),
    listGrants: route(200, async (s) => ({ grants: await service.listGrants(s) })),
    openSession: route(201, (s, req) => service.openSession(s, param(req, 'grantId'))),
    recordAccess: route(200, async (s, req) => {
      const b = bodyObject(req.body);
      const decision = await service.checkAccess(s, {
        practiceId: str(b, 'practiceId', true) as string,
        caseId: str(b, 'caseId', false),
        action: str(b, 'action', true) as string,
      });
      if (!decision.allowed) throw new SupportAccessError('forbidden', decision.reason);
      return { grantId: decision.grantId };
    }),
    accessLog: route(200, async (s, req) => {
      const q = req.query ?? {};
      const limit = q['limit'] === undefined ? undefined : Number(q['limit']);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new SupportAccessError('invalid_request', 'limit must be a positive integer');
      }
      const filter: AccessLogFilter = {
        ...(q['grantId'] !== undefined && { grantId: q['grantId'] }),
        ...(q['caseId'] !== undefined && { caseId: q['caseId'] }),
        ...(q['from'] !== undefined && { from: q['from'] }),
        ...(q['to'] !== undefined && { to: q['to'] }),
        ...(limit !== undefined && { limit }),
      };
      return { events: await service.accessLog(s, filter) };
    }),
    requestBreakGlass: route(201, (s, req) => {
      const b = bodyObject(req.body);
      return service.requestBreakGlass(s, {
        practiceId: str(b, 'practiceId', true) as string,
        reason: str(b, 'reason', true) as string,
        durationHours: num(b, 'durationHours'),
      });
    }),
    approveBreakGlass: route(200, (s, req) => service.approveBreakGlass(s, param(req, 'grantId'))),
  };
}
