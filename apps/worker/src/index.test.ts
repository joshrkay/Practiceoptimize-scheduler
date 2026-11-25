import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@scheduler/worker', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@scheduler/worker');
  });
});
