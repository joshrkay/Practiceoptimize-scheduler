/**
 * Detects fields that identify the practice (tenant, customer, organization) or carry a credential.
 * The runtime injects these server-side; a model-facing input schema must never declare them and a
 * model call must never supply them.
 */

const FORBIDDEN_FRAGMENTS = [
  'tenant',
  'practice',
  'customer',
  'credential',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'privatekey',
  'accesskey',
  'bearer',
  'vault',
] as const;

const FORBIDDEN_EXACT = new Set(['org', 'orgid', 'organization', 'organizationid']);

/** True when a field name looks like a practice/tenant/customer identifier or a credential. */
export function isScopeOrCredentialField(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (FORBIDDEN_EXACT.has(normalized)) return true;
  return FORBIDDEN_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Walks a JSON Schema and returns the dotted paths of every forbidden property it declares. */
export function findScopeFieldsInJsonSchema(schema: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, path));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'properties' && isRecord(child)) {
        for (const [prop, propSchema] of Object.entries(child)) {
          const propPath = path ? `${path}.${prop}` : prop;
          if (isScopeOrCredentialField(prop)) found.push(propPath);
          visit(propSchema, propPath);
        }
      } else if (key === 'required' || key === 'enum' || key === 'const') {
        // Values, not property declarations.
      } else {
        visit(child, path);
      }
    }
  };
  visit(schema, '');
  return found;
}

/** Walks a raw model-supplied value and returns the paths of every forbidden key it contains. */
export function findScopeFieldsInValue(value: unknown, maxDepth = 32): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (node: unknown, path: string, depth: number): void => {
    if (typeof node !== 'object' || node === null || depth > maxDepth || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isScopeOrCredentialField(key)) found.push(childPath);
      visit(child, childPath, depth + 1);
    }
  };
  visit(value, '', 0);
  return found;
}
