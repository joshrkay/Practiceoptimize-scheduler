export const INFRA_ENVS = ['dev', 'staging', 'prod'] as const;
export type InfraEnv = (typeof INFRA_ENVS)[number];

export interface EnvironmentConfig {
  readonly name: InfraEnv;
  readonly cidr: string;
  readonly maxAzs: number;
  readonly natGateways: number;
  readonly dbInstanceClass: string;
  readonly dbMultiAz: boolean;
  readonly dbAllocatedGb: number;
  readonly dbMaxAllocatedGb: number;
  readonly backupRetentionDays: number;
  readonly deletionProtection: boolean;
  /** Only prod may hold PHI or real secrets. dev and staging run synthetic data only. */
  readonly allowsPhi: boolean;
  /** Domains the workload may reach on the public internet, besides AWS service VPC endpoints. */
  readonly egressAllowlist: readonly string[];
}

/** Approved external systems: Availity, Redox (EHR connector). The model provider (Bedrock) uses a VPC endpoint. */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = ['.availity.com', '.redoxengine.com'];

const COMMON = {
  maxAzs: 2,
  dbAllocatedGb: 50,
  dbMaxAllocatedGb: 500,
} as const;

const BASE: Record<InfraEnv, Omit<EnvironmentConfig, 'egressAllowlist'>> = {
  dev: {
    ...COMMON,
    name: 'dev',
    cidr: '10.10.0.0/16',
    natGateways: 1,
    dbInstanceClass: 't4g.medium',
    dbMultiAz: false,
    backupRetentionDays: 7,
    deletionProtection: false,
    allowsPhi: false,
  },
  staging: {
    ...COMMON,
    name: 'staging',
    cidr: '10.20.0.0/16',
    natGateways: 1,
    dbInstanceClass: 'm7g.large',
    dbMultiAz: false,
    backupRetentionDays: 7,
    deletionProtection: false,
    allowsPhi: false,
  },
  prod: {
    ...COMMON,
    name: 'prod',
    cidr: '10.30.0.0/16',
    natGateways: 2,
    dbInstanceClass: 'm7g.xlarge',
    dbMultiAz: true,
    backupRetentionDays: 35,
    deletionProtection: true,
    allowsPhi: true,
  },
};

/** Parses a comma separated EGRESS_ALLOWLIST value. Entries must be domain names (no wildcards, schemes, or paths). */
export function parseEgressAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_EGRESS_ALLOWLIST;
  const entries = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const e of entries) {
    if (!/^\.?([a-z0-9-]+\.)+[a-z]{2,}$/.test(e)) {
      throw new Error(`EGRESS_ALLOWLIST entry "${e}" is not a bare domain name`);
    }
  }
  return entries;
}

export function parseInfraEnv(raw: string | undefined): InfraEnv {
  if ((INFRA_ENVS as readonly string[]).includes(raw ?? '')) return raw as InfraEnv;
  throw new Error(`INFRA_ENV must be one of ${INFRA_ENVS.join(', ')}; got "${raw ?? ''}"`);
}

export function loadEnvironmentConfig(
  env: Record<string, string | undefined> = process.env,
): EnvironmentConfig {
  const name = parseInfraEnv(env['INFRA_ENV']);
  return { ...BASE[name], egressAllowlist: parseEgressAllowlist(env['EGRESS_ALLOWLIST']) };
}

export function configFor(name: InfraEnv, egressAllowlist: readonly string[] = DEFAULT_EGRESS_ALLOWLIST): EnvironmentConfig {
  return { ...BASE[name], egressAllowlist };
}
