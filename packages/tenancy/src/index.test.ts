import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@scheduler/tenancy', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@scheduler/tenancy');
  });
});
