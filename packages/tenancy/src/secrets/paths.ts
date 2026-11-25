import type { PracticeId } from './ports.js';

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function assertSegment(label: string, value: string): void {
  if (!SEGMENT.test(value) || value.includes('..')) {
    throw new Error(`Invalid vault path ${label}`);
  }
}

/** Vault path `practices/{practice_id}/{system}/{name}`. */
export function secretPath(practiceId: PracticeId, system: string, name: string): string {
  assertSegment('practice id', practiceId);
  assertSegment('system', system);
  assertSegment('name', name);
  return `practices/${practiceId}/${system}/${name}`;
}
