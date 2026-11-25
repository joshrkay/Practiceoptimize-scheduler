import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@scheduler/integrations-availity', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@scheduler/integrations-availity');
  });
});
