import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@scheduler/integrations-portals', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@scheduler/integrations-portals');
  });
});
