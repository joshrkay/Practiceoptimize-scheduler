import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { getCaseSummary, makeUpdateCaseStatus } from './__fixtures__/sample-tools.js';
import { defineTool, ToolRegistrationError, ToolRegistry, type ToolDefinition } from './registry.js';

const readTool = (input: z.ZodObject, name = 'probe_tool'): ToolDefinition =>
  defineTool({
    name,
    description: 'A synthetic tool.',
    sideEffect: 'read',
    requiredPermission: 'case:read',
    input,
    output: z.object({}),
    execute: async () => ({}),
  });

describe('ToolRegistry', () => {
  it('registers allowlisted tools and lists model-facing descriptors', () => {
    const registry = new ToolRegistry().register(getCaseSummary).register(makeUpdateCaseStatus([]));
    expect(registry.has('get_case_summary')).toBe(true);
    expect(registry.get('nope')).toBeUndefined();
    const descriptors = registry.list();
    expect(descriptors.map((d) => [d.name, d.sideEffect])).toEqual([
      ['get_case_summary', 'read'],
      ['update_case_status', 'write'],
    ]);
    expect(descriptors[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { caseId: { type: 'string' } },
      required: ['caseId'],
    });
  });

  it.each([
    ['practiceId', z.object({ caseId: z.string(), practiceId: z.string() })],
    ['practice_id', z.object({ practice_id: z.string() })],
    ['tenant_id', z.object({ tenant_id: z.string() })],
    ['tenantId', z.object({ tenantId: z.string().optional() })],
    ['customer_id', z.object({ customer_id: z.string() })],
    ['customerId', z.object({ customerId: z.string() })],
    ['orgId', z.object({ orgId: z.string() })],
    ['credential', z.object({ credential: z.string() })],
    ['apiKey', z.object({ apiKey: z.string() })],
    ['password', z.object({ password: z.string() })],
    ['clientSecret', z.object({ clientSecret: z.string() })],
    ['accessToken', z.object({ accessToken: z.string() })],
    ['vaultPath', z.object({ vaultPath: z.string() })],
    ['nested filter.practiceId', z.object({ filter: z.object({ practiceId: z.string() }) })],
    ['array items[].tenant_id', z.object({ items: z.array(z.object({ tenant_id: z.string() })) })],
    ['union member', z.object({ target: z.union([z.string(), z.object({ customerId: z.string() })]) })],
    ['lazy schema', z.object({ deep: z.lazy(() => z.object({ bearerToken: z.string() })) })],
  ])('rejects at registration an input schema declaring %s', (_label, input) => {
    const registry = new ToolRegistry();
    expect(() => registry.register(readTool(input))).toThrow(ToolRegistrationError);
    expect(() => registry.register(readTool(input))).toThrow(/injected server-side/);
    expect(registry.list()).toEqual([]);
  });

  it('allows ordinary podiatry fields, including prior authorization and practitioner fields', () => {
    const input = z.object({
      caseId: z.string(),
      authorizationNumber: z.string(),
      practitionerNpi: z.string(),
      procedureCode: z.string(),
      note: z.object({ required: z.boolean(), enum: z.string() }),
    });
    expect(() => new ToolRegistry().register(readTool(input))).not.toThrow();
  });

  it('rejects duplicate and badly named tools', () => {
    const registry = new ToolRegistry().register(readTool(z.object({})));
    expect(() => registry.register(readTool(z.object({})))).toThrow(/already registered/);
    expect(() => registry.register(readTool(z.object({}), 'Bad-Name'))).toThrow(/snake_case/);
  });

  it('rejects malformed definitions', () => {
    const registry = new ToolRegistry();
    const valid = readTool(z.object({}), 'ok_tool');
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ input: z.string() }, /zod object/],
      [{ output: { parse: () => ({}) } }, /zod schema/],
      [{ requiredPermission: '' }, /permission/],
      [{ sideEffect: 'delete' }, /read or write/],
      [{ sideEffect: 'write' }, /describe its effect/],
    ];
    for (const [patch, message] of cases) {
      expect(() => registry.register({ ...valid, ...patch } as unknown as ToolDefinition)).toThrow(message);
    }
  });
});
