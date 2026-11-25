/**
 * Allowlist of the tools the agent may call. Each tool declares its input and output schemas, side-effect
 * class and required permission. Registration rejects any input schema that would let the model supply a
 * practice/tenant/customer identifier or a credential.
 */
import { z } from 'zod';
import type { ToolExecutionContext } from './context.js';
import type { IntendedEffect } from './dry-run.js';
import type { SideEffect } from './ports.js';
import { findScopeFieldsInJsonSchema } from './scope-fields.js';

export type ToolInputSchema = z.ZodObject;

interface ToolDefinitionBase<I extends ToolInputSchema, O extends z.ZodType> {
  /** snake_case, unique. */
  readonly name: string;
  /** Shown to the model. */
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly requiredPermission: string;
  /**
   * Case IDs this call refers to. The runtime resolves each inside the caller's practice before the
   * handler runs; any that does not resolve makes the call return "not found".
   */
  readonly caseIds?: (input: z.output<I>) => readonly string[];
  /** External systems whose credential handles the runtime should inject, e.g. `availity`. */
  readonly credentials?: readonly string[];
}

export interface ReadToolDefinition<I extends ToolInputSchema, O extends z.ZodType> extends ToolDefinitionBase<I, O> {
  readonly sideEffect: 'read';
  execute(input: z.output<I>, ctx: ToolExecutionContext): Promise<z.input<O>>;
}

export interface WriteToolDefinition<I extends ToolInputSchema, O extends z.ZodType> extends ToolDefinitionBase<I, O> {
  readonly sideEffect: 'write';
  execute(input: z.output<I>, ctx: ToolExecutionContext): Promise<z.input<O>>;
  /** What the call would do, returned instead of executing in dry-run mode. Must not have side effects. */
  describeEffect(input: z.output<I>, ctx: ToolExecutionContext): IntendedEffect;
}

export type ToolDefinition<I extends ToolInputSchema = ToolInputSchema, O extends z.ZodType = z.ZodType> =
  | ReadToolDefinition<I, O>
  | WriteToolDefinition<I, O>;

/** Identity helper that infers the handler's input and output types from the schemas. */
export function defineTool<I extends ToolInputSchema, O extends z.ZodType>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return definition;
}

/** What the planner sends to the model for each tool. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly sideEffect: SideEffect;
  readonly inputSchema: Record<string, unknown>;
}

export class ToolRegistrationError extends Error {
  constructor(
    readonly toolName: string,
    message: string,
  ) {
    super(`Cannot register tool "${toolName}": ${message}`);
    this.name = 'ToolRegistrationError';
  }
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly descriptor: ToolDescriptor;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<I extends ToolInputSchema, O extends z.ZodType>(definition: ToolDefinition<I, O>): this {
    const { name } = definition;
    if (!TOOL_NAME.test(name)) throw new ToolRegistrationError(name, 'the name must be snake_case.');
    if (this.tools.has(name)) throw new ToolRegistrationError(name, 'a tool with this name is already registered.');
    if (!(definition.input instanceof z.ZodObject)) {
      throw new ToolRegistrationError(name, 'the input schema must be a zod object.');
    }
    if (!(definition.output instanceof z.ZodType)) {
      throw new ToolRegistrationError(name, 'the output schema must be a zod schema.');
    }
    if (!definition.requiredPermission) throw new ToolRegistrationError(name, 'a required permission is missing.');
    if (definition.sideEffect !== 'read' && definition.sideEffect !== 'write') {
      throw new ToolRegistrationError(name, 'the side-effect class must be read or write.');
    }
    if (definition.sideEffect === 'write' && typeof definition.describeEffect !== 'function') {
      throw new ToolRegistrationError(name, 'a write tool must describe its effect for dry-run mode.');
    }

    const inputSchema = z.toJSONSchema(definition.input, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    const forbidden = findScopeFieldsInJsonSchema(inputSchema);
    if (forbidden.length > 0) {
      throw new ToolRegistrationError(
        name,
        `the input schema declares practice, tenant, customer or credential fields (${forbidden.join(', ')}). ` +
          'These are injected server-side from the tool context.',
      );
    }

    this.tools.set(name, {
      definition: definition as unknown as ToolDefinition,
      descriptor: Object.freeze({
        name,
        description: definition.description,
        sideEffect: definition.sideEffect,
        inputSchema,
      }),
    });
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => t.descriptor);
  }
}
