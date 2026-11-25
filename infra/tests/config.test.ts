import { describe, expect, it } from 'vitest';
import { DEFAULT_EGRESS_ALLOWLIST, loadEnvironmentConfig, parseEgressAllowlist, parseInfraEnv } from '../lib/config.js';

describe('infra config', () => {
  it('requires a valid INFRA_ENV', () => {
    expect(parseInfraEnv('prod')).toBe('prod');
    expect(() => parseInfraEnv(undefined)).toThrow(/INFRA_ENV/);
    expect(() => parseInfraEnv('qa')).toThrow(/INFRA_ENV/);
  });

  it('defaults the egress allowlist to Availity and Redox', () => {
    expect(parseEgressAllowlist(undefined)).toEqual(DEFAULT_EGRESS_ALLOWLIST);
    expect(parseEgressAllowlist('  ')).toEqual(DEFAULT_EGRESS_ALLOWLIST);
  });

  it('parses EGRESS_ALLOWLIST and rejects non-domain entries', () => {
    expect(parseEgressAllowlist('.Availity.com, api.vendor.io')).toEqual(['.availity.com', 'api.vendor.io']);
    for (const bad of ['*', 'https://x.com', 'x.com/path', 'localhost']) {
      expect(() => parseEgressAllowlist(bad)).toThrow(/EGRESS_ALLOWLIST/);
    }
  });

  it('loads per-environment settings; only prod allows PHI', () => {
    expect(loadEnvironmentConfig({ INFRA_ENV: 'dev' }).allowsPhi).toBe(false);
    expect(loadEnvironmentConfig({ INFRA_ENV: 'staging' }).allowsPhi).toBe(false);
    const prod = loadEnvironmentConfig({ INFRA_ENV: 'prod', EGRESS_ALLOWLIST: '.availity.com' });
    expect(prod).toMatchObject({ allowsPhi: true, dbMultiAz: true, egressAllowlist: ['.availity.com'] });
  });
});
