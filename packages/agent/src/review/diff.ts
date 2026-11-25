import type { DiffEntry } from './types';

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Path-level diff of two JSON-like input objects. Arrays are compared as whole values. */
export function diffInputs(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (isPlain(before) && isPlain(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffInputs(before[k], after[k], path === '' ? k : `${path}.${k}`));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, before, after }];
}
