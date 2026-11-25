/**
 * Ports this package needs from systems other packages own. Wired at integration:
 * - `CredentialProvider` <- practice vault paths and keys (RAH-11).
 * - `WorkspaceTaskSink` <- the scheduler workspace / review queue (RAH-19).
 * - `RedoxInboundMessageStore` <- the Redox webhook receiver in apps/api (RAH-22).
 * Each has an in-memory fake here for tests.
 */
import type { WorkspaceTaskDraft } from './capabilities.js';
import type { EhrResult } from './result.js';
import type { LocationId, PracticeId } from './types.js';

/** `fetch`-compatible function, injected so tests never touch the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type Clock = () => Date;

export type RedoxEnvironment = 'development' | 'staging' | 'production';

/** Non-secret Redox settings read from the practice's vault path. */
export interface RedoxCredentials {
  readonly environment: RedoxEnvironment;
  /** OAuth client ID of the practice's Redox API key. */
  readonly clientId: string;
  /** Token endpoint, stored with the credential rather than hard-coded. */
  readonly tokenUrl: string;
  /** Base URL of the Redox API (data model endpoint lives at `${apiBaseUrl}/endpoint`). */
  readonly apiBaseUrl: string;
}

/** OAuth 2.0 JWT client-assertion claims (RFC 7523). */
export interface ClientAssertionClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

/**
 * Reads Redox credentials from the practice's vault path. Secrets never leave the vault: the private key
 * signs the client assertion inside the provider (KMS or vault transit), and only the signed JWT returns.
 */
export interface CredentialProvider {
  getRedoxCredentials(practiceId: PracticeId): Promise<RedoxCredentials | undefined>;
  signRedoxClientAssertion(practiceId: PracticeId, claims: ClientAssertionClaims): Promise<string>;
}

export interface WorkspaceTaskSink {
  createTask(task: WorkspaceTaskDraft): Promise<{ readonly taskId: string }>;
}

/** A Redox message our webhook accepted and attributed to a practice location. */
export interface StoredRedoxMessage {
  readonly practiceId: PracticeId;
  readonly locationId: LocationId;
  /** ISO timestamp of receipt. */
  readonly receivedAt: string;
  readonly payload: unknown;
}

export interface RedoxInboundMessageStore {
  list(
    practiceId: PracticeId,
    locationId: LocationId,
    filter: { readonly dataModel: string; readonly since?: string },
  ): Promise<readonly StoredRedoxMessage[]>;
}

export type TaskFallbackOutcome<T> =
  | { readonly outcome: 'done'; readonly value: T }
  | { readonly outcome: 'task_created'; readonly taskId: string; readonly task: WorkspaceTaskDraft }
  | { readonly outcome: 'failed'; readonly code: string; readonly retryable: boolean; readonly message: string };

/**
 * The caller's side of the capability rule: run the connector result through this, and a capability
 * gap becomes a workspace task instead of disappearing.
 */
export async function resolveOrCreateTask<T>(
  result: EhrResult<T>,
  tasks: WorkspaceTaskSink,
): Promise<TaskFallbackOutcome<T>> {
  switch (result.status) {
    case 'ok':
      return { outcome: 'done', value: result.value };
    case 'unsupported': {
      const { taskId } = await tasks.createTask(result.workspaceTask);
      return { outcome: 'task_created', taskId, task: result.workspaceTask };
    }
    case 'error':
      return { outcome: 'failed', code: result.code, retryable: result.retryable, message: result.message };
  }
}

export class InMemoryWorkspaceTaskSink implements WorkspaceTaskSink {
  readonly tasks: { taskId: string; task: WorkspaceTaskDraft }[] = [];

  async createTask(task: WorkspaceTaskDraft): Promise<{ taskId: string }> {
    const taskId = `task-${this.tasks.length + 1}`;
    this.tasks.push({ taskId, task });
    return { taskId };
  }
}

export class InMemoryCredentialProvider implements CredentialProvider {
  readonly signed: ClientAssertionClaims[] = [];
  readonly #byPractice: Map<PracticeId, RedoxCredentials>;

  constructor(byPractice: Record<PracticeId, RedoxCredentials>) {
    this.#byPractice = new Map(Object.entries(byPractice));
  }

  async getRedoxCredentials(practiceId: PracticeId): Promise<RedoxCredentials | undefined> {
    return this.#byPractice.get(practiceId);
  }

  async signRedoxClientAssertion(practiceId: PracticeId, claims: ClientAssertionClaims): Promise<string> {
    this.signed.push(claims);
    return `test-assertion.${practiceId}.${claims.jti}`;
  }
}

export class InMemoryRedoxInboundMessageStore implements RedoxInboundMessageStore {
  readonly #messages: StoredRedoxMessage[] = [];

  add(message: StoredRedoxMessage): void {
    this.#messages.push(message);
  }

  async list(
    practiceId: PracticeId,
    locationId: LocationId,
    filter: { dataModel: string; since?: string },
  ): Promise<readonly StoredRedoxMessage[]> {
    const since = filter.since === undefined ? undefined : Date.parse(filter.since);
    return this.#messages.filter(
      (m) =>
        m.practiceId === practiceId &&
        m.locationId === locationId &&
        dataModelOf(m.payload) === filter.dataModel &&
        (since === undefined || Date.parse(m.receivedAt) >= since),
    );
  }
}

function dataModelOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const meta = (payload as { Meta?: { DataModel?: unknown } }).Meta;
  return typeof meta?.DataModel === 'string' ? meta.DataModel : undefined;
}
