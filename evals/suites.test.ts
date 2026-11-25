import { describe, expect, it } from 'vitest';
import { runSuites, suites } from './suites.js';

describe('eval runner', () => {
  it('runs every suite when none is named', async () => {
    const results = await runSuites([]);
    expect(results.map((result) => result.name)).toEqual(suites.map((suite) => suite.name));
    expect(results.every((result) => result.failed === 0)).toBe(true);
  });

  it('runs only the named suite', async () => {
    const results = await runSuites(['smoke']);
    expect(results).toEqual([{ name: 'smoke', passed: 1, failed: 0, failures: [] }]);
  });

  it('rejects an unknown suite', async () => {
    await expect(runSuites(['missing'])).rejects.toThrow('Unknown eval suite: missing');
  });
});
