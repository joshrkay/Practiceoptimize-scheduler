/**
 * In-memory fakes for every change-plan port. Test use only: no network, synthetic data.
 * One `FakeCascadeWorld` implements all ports and records every write in `calls`.
 */
import { DAY_MS, utcDate } from './impact.js';
import type { CaseSnapshot, Slot } from './model.js';
import type { ExecutionPorts, PlanningPorts, SlotQuery, WriteContext } from './ports.js';

export interface RecordedCall {
  readonly port: string;
  readonly method: string;
  readonly caseId: string;
  readonly idempotencyKey: string;
  readonly args: unknown;
}

export class FakeCascadeWorld {
  readonly cases = new Map<string, CaseSnapshot>();
  slots: Slot[] = [];
  readonly calls: RecordedCall[] = [];
  readonly slotQueries: SlotQuery[] = [];
  /** `port.method` -> number of upcoming calls that should throw. */
  private readonly failures = new Map<string, number>();
  private counter = 0;
  nowIso = '2026-12-01T15:00:00.000Z';

  constructor(cases: readonly CaseSnapshot[] = [], slots: readonly Slot[] = []) {
    for (const c of cases) this.cases.set(c.caseId, c);
    this.slots = [...slots];
  }

  failNext(portMethod: string, times = 1): void {
    this.failures.set(portMethod, (this.failures.get(portMethod) ?? 0) + times);
  }

  writesTo(port: string, method?: string): RecordedCall[] {
    return this.calls.filter((c) => c.port === port && (method === undefined || c.method === method));
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private async write(port: string, method: string, ctx: WriteContext, args: unknown): Promise<void> {
    const key = `${port}.${method}`;
    const pending = this.failures.get(key) ?? 0;
    if (pending > 0) {
      this.failures.set(key, pending - 1);
      throw new Error(`${key} unavailable (simulated)`);
    }
    this.calls.push({ port, method, caseId: ctx.caseId, idempotencyKey: ctx.idempotencyKey, args });
  }

  planningPorts(): PlanningPorts {
    return {
      cases: {
        getCase: async (_practiceId, caseId) => this.cases.get(caseId),
        listSeries: async (practiceId, seriesId) =>
          [...this.cases.values()]
            .filter((c) => c.practiceId === practiceId && c.series?.seriesId === seriesId)
            .sort((a, b) => (a.series?.position ?? 0) - (b.series?.position ?? 0)),
        listCasesForSurgeonOnDate: async (practiceId, surgeonId, date) =>
          [...this.cases.values()].filter(
            (c) => c.practiceId === practiceId && c.surgeonId === surgeonId && utcDate(c.scheduledStart) === date,
          ),
      },
      slots: {
        // Matching slots, closest to the preferred start first.
        findSlots: async (q) => {
          this.slotQueries.push(q);
          const pref = Date.parse(q.preferredStart);
          return this.slots
            .filter(
              (s) =>
                s.surgeonId === q.surgeonId &&
                (q.facilityId === undefined || s.facilityId === q.facilityId) &&
                (q.siteOfService === undefined || s.siteOfService === q.siteOfService) &&
                Date.parse(s.start) >= Date.parse(q.earliestStart) &&
                Date.parse(s.end) - Date.parse(s.start) >= q.durationMinutes * 60_000 &&
                !(q.excludeDates ?? []).includes(utcDate(s.start)),
            )
            .sort((a, b) => Math.abs(Date.parse(a.start) - pref) - Math.abs(Date.parse(b.start) - pref));
        },
      },
      authorization: {
        checkWindow: async (q) => {
          const a = q.authorization;
          if (!a) return { covered: false, reason: 'No authorization on file.' };
          const t = Date.parse(q.scheduledStart);
          if (t < Date.parse(a.validFrom) || t > Date.parse(a.validThrough)) {
            return { covered: false, reason: `New date is outside the authorization window (valid through ${a.validThrough}).` };
          }
          const missing = q.cptCodes.filter((code) => !a.cptCodes.includes(code));
          if (missing.length > 0) return { covered: false, reason: `Codes ${missing.join(', ')} are not authorized.` };
          if (a.facilityId && a.facilityId !== q.facilityId) {
            return { covered: false, reason: 'Authorization is for a different facility.' };
          }
          return { covered: true, reason: 'Within the authorization window.' };
        },
      },
      readiness: {
        findExpiring: async (_p, _c, items, newStart) =>
          items.filter((i) => Date.parse(i.completedOn) + i.validForDays * DAY_MS < Date.parse(newStart)),
      },
      clock: { now: () => this.nowIso },
      ids: { next: (prefix) => this.id(prefix) },
    };
  }

  executionPorts(): ExecutionPorts {
    return {
      caseState: {
        transition: async (ctx, to, reason) => {
          await this.write('caseState', 'transition', ctx, { to, reason });
          const c = this.cases.get(ctx.caseId);
          if (c) this.cases.set(c.caseId, { ...c, status: to });
        },
      },
      authorization: {
        resubmit: async (ctx, req) => {
          await this.write('authorization', 'resubmit', ctx, req);
          return { submissionId: this.id('pas') };
        },
      },
      readiness: { reopen: (ctx, itemId, reason) => this.write('readiness', 'reopen', ctx, { itemId, reason }) },
      facility: {
        post: async (ctx, slot) => {
          await this.write('facility', 'post', ctx, slot);
          return { postingId: this.id('posting') };
        },
        update: async (ctx, slot) => {
          await this.write('facility', 'update', ctx, slot);
          return { postingId: this.id('posting') };
        },
        cancel: (ctx, facilityId, slotId) => this.write('facility', 'cancel', ctx, { facilityId, slotId }),
      },
      coordination: {
        updateRequest: (ctx, requestId, change) => this.write('coordination', 'updateRequest', ctx, { requestId, ...change }),
        cancelRequest: (ctx, requestId) => this.write('coordination', 'cancelRequest', ctx, { requestId }),
      },
      postOp: {
        move: async (ctx, appointmentId, newStart) => {
          await this.write('postOp', 'move', ctx, { appointmentId, newStart });
          return { appointmentId };
        },
        cancel: (ctx, appointmentId) => this.write('postOp', 'cancel', ctx, { appointmentId }),
      },
      messaging: {
        send: async (ctx, message) => {
          await this.write('messaging', 'send', ctx, message);
          return { messageId: this.id('msg') };
        },
      },
      ehr: { updateCase: (ctx, change) => this.write('ehr', 'updateCase', ctx, change) },
      practiceManagement: { updateCase: (ctx, change) => this.write('practiceManagement', 'updateCase', ctx, change) },
      waitlist: { releaseSlot: (ctx, slot) => this.write('waitlist', 'releaseSlot', ctx, slot) },
      reviewQueue: {
        createTask: async (task) => {
          const taskId = this.id('task');
          this.calls.push({ port: 'reviewQueue', method: 'createTask', caseId: '', idempotencyKey: taskId, args: task });
          return { taskId };
        },
      },
      clock: { now: () => this.nowIso },
    };
  }
}
