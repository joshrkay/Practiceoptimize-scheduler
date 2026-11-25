import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@scheduler/db', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@scheduler/db');
  });
});
