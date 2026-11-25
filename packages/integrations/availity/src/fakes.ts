import type {
  AccessToken,
  AuditSink,
  AvailityAuditRecord,
  ConnectionIssue,
  CredentialProvider,
  PracticeConnectionPort,
  PracticeId,
} from './ports.js';

export class InMemoryCredentialProvider implements CredentialProvider {
  readonly refreshCalls: PracticeId[] = [];
  private readonly tokens = new Map<PracticeId, AccessToken>();
  private readonly refreshResults = new Map<PracticeId, AccessToken>();

  set(practiceId: PracticeId, token: AccessToken, refreshedTo?: AccessToken): void {
    this.tokens.set(practiceId, token);
    if (refreshedTo) this.refreshResults.set(practiceId, refreshedTo);
  }
  getToken(practiceId: PracticeId): Promise<AccessToken | null> {
    return Promise.resolve(this.tokens.get(practiceId) ?? null);
  }
  refreshToken(practiceId: PracticeId): Promise<AccessToken | null> {
    this.refreshCalls.push(practiceId);
    const next = this.refreshResults.get(practiceId) ?? null;
    if (next) this.tokens.set(practiceId, next);
    return Promise.resolve(next);
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly records: AvailityAuditRecord[] = [];
  record(entry: AvailityAuditRecord): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }
}

export class InMemoryPracticeConnection implements PracticeConnectionPort {
  readonly paused = new Map<PracticeId, ConnectionIssue>();
  reconnectRequired(practiceId: PracticeId, issue: ConnectionIssue): Promise<void> {
    this.paused.set(practiceId, issue);
    return Promise.resolve();
  }
}
