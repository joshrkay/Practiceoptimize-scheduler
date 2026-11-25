/**
 * Runs a model-requested tool call: validate, scope to the caller's practice, execute (or describe in
 * dry-run mode), validate the output, and audit. Every call writes exactly one tool-call audit event.
 */
import { createExecutionContext, type ToolContext } from './context.js';
import type { IntendedEffect } from './dry-run.js';
import type {
  AuditSink,
  CaseLookup,
  CaseOwnershipProbe,
  CaseRef,
  Clock,
  CredentialHandle,
  CredentialHandleProvider,
  SecurityEventKind,
  ToolCallOutcome,
} from './ports.js';
import type { ToolDefinition, ToolRegistry } from './registry.js';
import { findScopeFieldsInValue } from './scope-fields.js';

export interface ToolInputIssue {
  readonly path: string;
  readonly message: string;
}

export type ToolResult =
  | { readonly status: 'ok'; readonly tool: string; readonly output: unknown }
  | { readonly status: 'dry_run'; readonly tool: string; readonly effect: IntendedEffect }
  | { readonly status: 'not_found'; readonly tool: string; readonly message: 'Not found.' }
  | { readonly status: 'invalid_input'; readonly tool: string; readonly issues: readonly ToolInputIssue[] }
  | { readonly status: 'forbidden'; readonly tool: string; readonly message: string }
  | { readonly status: 'unknown_tool'; readonly tool: string; readonly message: string }
  | { readonly status: 'error'; readonly tool: string; readonly message: string };

export interface ToolExecutorDeps {
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
  readonly cases: CaseLookup;
  readonly credentials: CredentialHandleProvider;
  /** When absent, every unresolved case reference is treated as a possible cross-practice attempt. */
  readonly ownershipProbe?: CaseOwnershipProbe;
  readonly clock?: Clock;
}

const systemClock: Clock = { now: () => new Date() };

const argumentNamesOf = (raw: unknown): string[] =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Object.keys(raw).sort() : [];

export class ToolExecutor {
  private readonly clock: Clock;

  constructor(private readonly deps: ToolExecutorDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async invoke(toolName: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const definition = this.deps.registry.get(toolName);
    let resolvedCaseIds: string[] = [];
    const finish = async (result: ToolResult): Promise<ToolResult> => {
      const outcome: ToolCallOutcome = result.status === 'ok' ? 'success' : result.status;
      await this.deps.audit.recordToolCall({
        type: 'tool_call',
        at: this.clock.now().toISOString(),
        practiceId: ctx.practiceId,
        locationId: ctx.locationId,
        actorUserId: ctx.userId,
        correlationId: ctx.correlationId,
        toolName,
        sideEffect: definition?.sideEffect ?? null,
        dryRun: ctx.dryRun,
        outcome,
        argumentNames: argumentNamesOf(rawInput),
        caseIds: resolvedCaseIds,
      });
      return result;
    };

    if (!definition) {
      return finish({ status: 'unknown_tool', tool: toolName, message: 'This tool is not available.' });
    }

    const scopeFields = findScopeFieldsInValue(rawInput);
    if (scopeFields.length > 0) {
      await this.securityEvent(ctx, toolName, 'scope_argument_supplied', `Model supplied: ${scopeFields.join(', ')}`);
      return finish({
        status: 'invalid_input',
        tool: toolName,
        issues: scopeFields.map((path) => ({
          path,
          message: 'Practice, tenant, customer and credential values are set by the server and cannot be supplied.',
        })),
      });
    }

    if (!ctx.permissions.has(definition.requiredPermission)) {
      return finish({ status: 'forbidden', tool: toolName, message: 'The caller lacks permission for this tool.' });
    }

    const parsed = definition.input.safeParse(rawInput);
    if (!parsed.success) {
      return finish({
        status: 'invalid_input',
        tool: toolName,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const input = parsed.data;

    const cases = new Map<string, CaseRef>();
    for (const caseId of definition.caseIds?.(input) ?? []) {
      const found = await this.deps.cases.findCase(ctx.practiceId, caseId);
      if (!found || found.practiceId !== ctx.practiceId) {
        await this.reportUnresolvedCase(ctx, toolName, caseId);
        return finish({ status: 'not_found', tool: toolName, message: 'Not found.' });
      }
      cases.set(caseId, found);
    }
    resolvedCaseIds = [...cases.keys()];

    const credentials = new Map<string, CredentialHandle>();
    try {
      for (const system of definition.credentials ?? []) {
        credentials.set(system, await this.deps.credentials.handleFor(ctx.practiceId, system));
      }
    } catch {
      return finish({ status: 'error', tool: toolName, message: 'A required credential is unavailable.' });
    }

    const execCtx = createExecutionContext(ctx, cases, credentials);

    if (ctx.dryRun && definition.sideEffect === 'write') {
      try {
        return finish({ status: 'dry_run', tool: toolName, effect: definition.describeEffect(input, execCtx) });
      } catch {
        return finish({ status: 'error', tool: toolName, message: 'The tool could not describe its effect.' });
      }
    }

    return finish(await this.run(definition, input, execCtx));
  }

  private async run(
    definition: ToolDefinition,
    input: Record<string, unknown>,
    execCtx: ReturnType<typeof createExecutionContext>,
  ): Promise<ToolResult> {
    const tool = definition.name;
    let raw: unknown;
    try {
      raw = await definition.execute(input, execCtx);
    } catch {
      return { status: 'error', tool, message: 'The tool failed.' };
    }
    const output = definition.output.safeParse(raw);
    if (!output.success) {
      return { status: 'error', tool, message: 'The tool returned an invalid result.' };
    }
    return { status: 'ok', tool, output: output.data };
  }

  private async reportUnresolvedCase(ctx: ToolContext, toolName: string, caseId: string): Promise<void> {
    const probe = this.deps.ownershipProbe;
    if (probe && !(await probe.belongsToAnotherPractice(ctx.practiceId, caseId))) {
      // A genuinely missing case is an ordinary not-found, audited by the tool-call event.
      return;
    }
    const kind: SecurityEventKind = probe ? 'cross_practice_reference' : 'unresolved_case_reference';
    await this.securityEvent(ctx, toolName, kind, `Case reference ${caseId} did not resolve in the caller's practice.`);
  }

  private async securityEvent(
    ctx: ToolContext,
    toolName: string,
    kind: SecurityEventKind,
    detail: string,
  ): Promise<void> {
    await this.deps.audit.recordSecurityEvent({
      type: 'security',
      kind,
      at: this.clock.now().toISOString(),
      practiceId: ctx.practiceId,
      actorUserId: ctx.userId,
      correlationId: ctx.correlationId,
      toolName,
      detail,
    });
  }
}
