/** In-memory fakes for the tool layer ports. For tests and local development only. */
import type {
  AuditSink,
  CaseLookup,
  CaseOwnershipProbe,
  CaseRef,
  CredentialHandle,
  CredentialHandleProvider,
  PracticeId,
  SecurityEvent,
  ToolCallAuditEvent,
} from './ports.js';

export class InMemoryAuditSink implements AuditSink {
  readonly toolCalls: ToolCallAuditEvent[] = [];
  readonly securityEvents: SecurityEvent[] = [];

  async recordToolCall(event: ToolCallAuditEvent): Promise<void> {
    this.toolCalls.push(event);
  }

  async recordSecurityEvent(event: SecurityEvent): Promise<void> {
    this.securityEvents.push(event);
  }
}

/** Holds cases for many practices but, like row-level security, only answers inside one practice. */
export class InMemoryCaseStore implements CaseLookup, CaseOwnershipProbe {
  private readonly cases = new Map<string, CaseRef>();

  constructor(cases: readonly CaseRef[] = []) {
    for (const c of cases) this.cases.set(c.caseId, c);
  }

  add(c: CaseRef): void {
    this.cases.set(c.caseId, c);
  }

  async findCase(practice: PracticeId, caseId: string): Promise<CaseRef | null> {
    const found = this.cases.get(caseId);
    return found && found.practiceId === practice ? found : null;
  }

  async belongsToAnotherPractice(caller: PracticeId, caseId: string): Promise<boolean> {
    const found = this.cases.get(caseId);
    return found !== undefined && found.practiceId !== caller;
  }
}

export class InMemoryCredentialHandleProvider implements CredentialHandleProvider {
  readonly issued: CredentialHandle[] = [];

  async handleFor(practice: PracticeId, system: string): Promise<CredentialHandle> {
    const handle: CredentialHandle = Object.freeze({
      kind: 'credential_handle',
      system,
      practiceId: practice,
      vaultPath: `practices/${practice}/credentials/${system}`,
    });
    this.issued.push(handle);
    return handle;
  }
}
