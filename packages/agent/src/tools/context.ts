/**
 * Server-side tool context. Practice, location, user, permissions and credential handles come from the
 * authenticated session and the vault, never from model output.
 */
import { isToolDryRunEnabled } from './dry-run.js';
import type { CaseRef, CredentialHandle, LocationId, PracticeId, UserId } from './ports.js';

/** What the API layer knows about the signed-in caller (or the agent acting for a practice). */
export interface AuthenticatedSession {
  readonly practiceId: PracticeId;
  readonly locationId: LocationId | null;
  readonly userId: UserId;
  readonly permissions: readonly string[];
}

/** Per-request context the runtime passes to `ToolExecutor.invoke`. */
export interface ToolContext {
  readonly practiceId: PracticeId;
  readonly locationId: LocationId | null;
  readonly userId: UserId;
  readonly permissions: ReadonlySet<string>;
  readonly correlationId: string;
  readonly dryRun: boolean;
}

export interface CreateToolContextOptions {
  readonly correlationId: string;
  /** Overrides the `FEATURE_TOOL_DRY_RUN` flag. */
  readonly dryRun?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createToolContext(session: AuthenticatedSession, options: CreateToolContextOptions): ToolContext {
  if (!session.practiceId) throw new Error('A tool context requires a practice from the authenticated session.');
  if (!options.correlationId) throw new Error('A tool context requires a correlation ID.');
  return Object.freeze({
    practiceId: session.practiceId,
    locationId: session.locationId,
    userId: session.userId,
    permissions: new Set(session.permissions),
    correlationId: options.correlationId,
    dryRun: options.dryRun ?? isToolDryRunEnabled(options.env),
  });
}

/**
 * What a tool handler receives: the request context plus the cases the runtime already resolved inside
 * the caller's practice and the credential handles the tool declared.
 */
export interface ToolExecutionContext extends ToolContext {
  /** Returns a case resolved for this call. Throws if the tool did not declare it through `caseIds`. */
  caseRef(caseId: string): CaseRef;
  /** Returns the handle for a system the tool declared in `credentials`. */
  credential(system: string): CredentialHandle;
}

export function createExecutionContext(
  ctx: ToolContext,
  cases: ReadonlyMap<string, CaseRef>,
  credentials: ReadonlyMap<string, CredentialHandle>,
): ToolExecutionContext {
  return Object.freeze({
    ...ctx,
    caseRef(caseId: string): CaseRef {
      const found = cases.get(caseId);
      if (!found) throw new Error(`Case ${caseId} was not resolved for this call.`);
      return found;
    },
    credential(system: string): CredentialHandle {
      const handle = credentials.get(system);
      if (!handle) throw new Error(`No credential handle for ${system} was declared by this tool.`);
      return handle;
    },
  });
}
