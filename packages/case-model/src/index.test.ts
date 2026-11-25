import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@scheduler/case-model', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@scheduler/case-model');
  });
});
