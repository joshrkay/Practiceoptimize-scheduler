/**
 * Ports the review queue needs from packages that are built elsewhere (policy engine, tool layer,
 * audit log). Wire real implementations at integration time; the fakes below are for tests.
 */

export type PracticeId = string;

/** A proposed action as the policy engine and tool layer see it. */
export interface ProposedActionRef {
  readonly practiceId: PracticeId;
  readonly caseId: string;
  readonly actionType: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export type HardRuleResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Re-runs the policy engine's hard rules against the (possibly edited) inputs. */
export type HardRuleCheck = (action: ProposedActionRef) => Promise<HardRuleResult>;

export type ExecutionResult =
  | { readonly ok: true; readonly detail?: string }
  | { readonly ok: false; readonly error: string };

/** Executes an approved action through the tool layer. */
export interface ActionExecutor {
  execute(action: ProposedActionRef): Promise<ExecutionResult>;
}

export interface AuditEvent {
  readonly practiceId: PracticeId;
  readonly actorId: string;
  readonly action: string;
  readonly itemId?: string;
  readonly caseId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/** Notifies the practice admin that an item expired unreviewed. */
export interface Escalator {
  escalateToPracticeAdmin(practiceId: PracticeId, itemId: string, reason: string): Promise<void>;
}

export class FakeAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeExecutor implements ActionExecutor {
  readonly executed: ProposedActionRef[] = [];
  failWith: string | undefined;
  async execute(action: ProposedActionRef): Promise<ExecutionResult> {
    if (this.failWith !== undefined) return { ok: false, error: this.failWith };
    this.executed.push(action);
    return { ok: true };
  }
}

export class FakeEscalator implements Escalator {
  readonly escalations: { practiceId: PracticeId; itemId: string; reason: string }[] = [];
  async escalateToPracticeAdmin(practiceId: PracticeId, itemId: string, reason: string): Promise<void> {
    this.escalations.push({ practiceId, itemId, reason });
  }
}
