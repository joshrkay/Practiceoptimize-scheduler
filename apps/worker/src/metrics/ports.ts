/**
 * Input shapes for pilot metrics. Audit events (RAH-8) and case history (RAH-15) are built elsewhere;
 * these local shapes are what the metrics code needs and are wired up at integration.
 * Case ids are opaque and only used to count distinct cases. They never reach an output.
 */
export type PracticeId = string;

export type AuditEventKind =
  | 'agent_action'
  | 'action_edited'
  | 'action_rejected'
  | 'workspace_activity'
  | 'patient_inbound_call';

export interface MetricAuditEvent {
  practiceId: PracticeId;
  kind: AuditEventKind;
  /** ISO 8601 timestamp. */
  occurredAt: string;
  caseId?: string;
  /** Scheduler minutes, for workspace_activity events. */
  minutes?: number;
}

export type CancellationReason =
  | 'patient_request'
  | 'illness'
  | 'transport'
  | 'insurance'
  | 'facility'
  | 'surgeon'
  | 'other';

export interface CaseHistoryRecord {
  practiceId: PracticeId;
  caseId: string;
  orderedAt: string;
  authDecisionAt?: string;
  authDecision?: 'approved' | 'denied';
  /** True when the authorization was decided without resubmission. */
  authFirstPass?: boolean;
  cancellation?: { cancelledAt: string; scheduledFor: string; reason: CancellationReason };
}

export interface MetricsSource {
  auditEvents(practiceId: PracticeId, from: Date, to: Date): Promise<MetricAuditEvent[]>;
  caseHistory(practiceId: PracticeId): Promise<CaseHistoryRecord[]>;
}

export class InMemoryMetricsSource implements MetricsSource {
  constructor(
    private readonly events: MetricAuditEvent[] = [],
    private readonly cases: CaseHistoryRecord[] = [],
  ) {}
  async auditEvents(practiceId: PracticeId, from: Date, to: Date): Promise<MetricAuditEvent[]> {
    return this.events.filter(
      (e) =>
        e.practiceId === practiceId &&
        Date.parse(e.occurredAt) >= from.getTime() &&
        Date.parse(e.occurredAt) < to.getTime(),
    );
  }
  async caseHistory(practiceId: PracticeId): Promise<CaseHistoryRecord[]> {
    return this.cases.filter((c) => c.practiceId === practiceId);
  }
}
