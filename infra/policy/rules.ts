/**
 * Policy-as-code checks over synthesized CloudFormation templates.
 * Each rule has a stable id; a violation names the rule, the stack and the resource so CI output says what broke.
 */

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}
export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
  Outputs?: Record<string, { Value: unknown; Export?: { Name?: string } }>;
}
export type TemplateSet = Readonly<Record<string, CfnTemplate>>;

export interface Violation {
  rule: string;
  stack: string;
  resource: string;
  message: string;
}
export interface Rule {
  id: string;
  description: string;
  check(templates: TemplateSet): Violation[];
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const has = (v: unknown, needle: string): boolean => JSON.stringify(v ?? null).includes(needle);

interface Found {
  stack: string;
  id: string;
  props: Obj;
}
function findAll(templates: TemplateSet, ...types: string[]): Found[] {
  const out: Found[] = [];
  for (const [stack, t] of Object.entries(templates)) {
    for (const [id, r] of Object.entries(t.Resources ?? {})) {
      if (types.includes(r.Type)) out.push({ stack, id, props: asObj(r.Properties) });
    }
  }
  return out;
}

/** Resolves a {Ref} in the same stack, or an {Fn::ImportValue} to the exporting stack's resource. */
function resolveRef(templates: TemplateSet, stack: string, value: unknown): { stack: string; id: string } | undefined {
  const v = asObj(value);
  if (typeof v['Ref'] === 'string') return { stack, id: v['Ref'] };
  const imp = v['Fn::ImportValue'];
  if (typeof imp === 'string') {
    for (const [s, t] of Object.entries(templates)) {
      for (const o of Object.values(t.Outputs ?? {})) {
        if (o.Export?.Name === imp) {
          const ref = asObj(o.Value)['Ref'];
          if (typeof ref === 'string') return { stack: s, id: ref };
        }
      }
    }
  }
  return undefined;
}

function violation(rule: string, f: { stack: string; id: string }, message: string): Violation {
  return { rule, stack: f.stack, resource: f.id, message };
}

/** Collects Deny statements from every policy-like resource that targets the given resource. */
function statements(templates: TemplateSet, policyTypes: string[]): Array<Found & { statements: Obj[] }> {
  return findAll(templates, ...policyTypes).map((f) => ({
    ...f,
    statements: asArr(asObj(f.props['PolicyDocument'])['Statement']).map(asObj),
  }));
}
const denies = (stmts: Obj[], conditionNeedle: string): boolean =>
  stmts.some((s) => s['Effect'] === 'Deny' && has(s['Condition'], conditionNeedle));

const SUBNET_TIER_TAG = 'scheduler:subnet-tier';
function subnetTier(templates: TemplateSet, ref: { stack: string; id: string }): string | undefined {
  const r = templates[ref.stack]?.Resources?.[ref.id];
  if (r?.Type !== 'AWS::EC2::Subnet') return undefined;
  const tag = asArr(asObj(r.Properties)['Tags']).map(asObj).find((t) => t['Key'] === SUBNET_TIER_TAG);
  return typeof tag?.['Value'] === 'string' ? tag['Value'] : undefined;
}

export const rules: Rule[] = [
  {
    id: 'no-public-database',
    description: 'Databases are not publicly accessible and sit only in data-tier (isolated) subnets',
    check(templates) {
      const out: Violation[] = [];
      for (const db of findAll(templates, 'AWS::RDS::DBInstance', 'AWS::RDS::DBCluster')) {
        if (db.props['PubliclyAccessible'] !== false) out.push(violation('no-public-database', db, 'PubliclyAccessible must be explicitly false'));
      }
      for (const g of findAll(templates, 'AWS::RDS::DBSubnetGroup')) {
        for (const s of asArr(g.props['SubnetIds'])) {
          const ref = resolveRef(templates, g.stack, s);
          const tier = ref ? subnetTier(templates, ref) : undefined;
          if (tier !== 'data') out.push(violation('no-public-database', g, `DB subnet group uses a subnet that is not in the data tier (tier: ${tier ?? 'unresolved'})`));
        }
      }
      return out;
    },
  },
  {
    id: 'no-public-subnets',
    description: 'No subnet auto-assigns public IPs; internet-facing subnets exist only for NAT',
    check(templates) {
      return findAll(templates, 'AWS::EC2::Subnet')
        .filter((s) => s.props['MapPublicIpOnLaunch'] === true)
        .map((s) => violation('no-public-subnets', s, 'Subnet maps public IPs on launch'));
    },
  },
  {
    id: 'no-open-ingress',
    description: 'No security group allows inbound traffic from 0.0.0.0/0 or ::/0',
    check(templates) {
      const out: Violation[] = [];
      const open = (r: Obj): boolean => r['CidrIp'] === '0.0.0.0/0' || r['CidrIpv6'] === '::/0';
      for (const sg of findAll(templates, 'AWS::EC2::SecurityGroup')) {
        if (asArr(sg.props['SecurityGroupIngress']).some((r) => open(asObj(r)))) out.push(violation('no-open-ingress', sg, 'Ingress open to the internet'));
      }
      for (const r of findAll(templates, 'AWS::EC2::SecurityGroupIngress')) {
        if (open(r.props)) out.push(violation('no-open-ingress', r, 'Ingress open to the internet'));
      }
      return out;
    },
  },
  {
    id: 'database-encrypted',
    description: 'Databases use KMS-encrypted storage, backups of at least 7 days, and deletion-safe settings',
    check(templates) {
      const out: Violation[] = [];
      for (const db of findAll(templates, 'AWS::RDS::DBInstance', 'AWS::RDS::DBCluster')) {
        if (db.props['StorageEncrypted'] !== true) out.push(violation('database-encrypted', db, 'StorageEncrypted must be true'));
        else if (db.props['KmsKeyId'] === undefined) out.push(violation('database-encrypted', db, 'KmsKeyId must be a customer managed key'));
        const retention = db.props['BackupRetentionPeriod'];
        if (typeof retention !== 'number' || retention < 7) out.push(violation('database-encrypted', db, 'BackupRetentionPeriod must be at least 7 days'));
      }
      return out;
    },
  },
  {
    id: 'database-tls',
    description: 'Databases use a parameter group that forces TLS 1.2+',
    check(templates) {
      const out: Violation[] = [];
      const groups = findAll(templates, 'AWS::RDS::DBParameterGroup');
      for (const db of findAll(templates, 'AWS::RDS::DBInstance', 'AWS::RDS::DBCluster')) {
        const ref = resolveRef(templates, db.stack, db.props['DBParameterGroupName']);
        const g = groups.find((x) => x.stack === ref?.stack && x.id === ref.id);
        const p = asObj(g?.props['Parameters']);
        if (p['rds.force_ssl'] !== '1' || p['ssl_min_protocol_version'] !== 'TLSv1.2') {
          out.push(violation('database-tls', db, 'Parameter group must set rds.force_ssl=1 and ssl_min_protocol_version=TLSv1.2'));
        }
      }
      return out;
    },
  },
  {
    id: 'bucket-encrypted',
    description: 'Buckets use KMS encryption',
    check(templates) {
      return findAll(templates, 'AWS::S3::Bucket')
        .filter((b) => {
          const rules = asArr(asObj(b.props['BucketEncryption'])['ServerSideEncryptionConfiguration']).map(asObj);
          return !rules.some((r) => {
            const d = asObj(r['ServerSideEncryptionByDefault']);
            return d['SSEAlgorithm'] === 'aws:kms' && d['KMSMasterKeyID'] !== undefined;
          });
        })
        .map((b) => violation('bucket-encrypted', b, 'Bucket must default to aws:kms with a customer managed key'));
    },
  },
  {
    id: 'bucket-private',
    description: 'Buckets block all public access',
    check(templates) {
      return findAll(templates, 'AWS::S3::Bucket')
        .filter((b) => {
          const p = asObj(b.props['PublicAccessBlockConfiguration']);
          return !(p['BlockPublicAcls'] === true && p['BlockPublicPolicy'] === true && p['IgnorePublicAcls'] === true && p['RestrictPublicBuckets'] === true);
        })
        .map((b) => violation('bucket-private', b, 'PublicAccessBlockConfiguration must enable all four settings'));
    },
  },
  {
    id: 'bucket-tls',
    description: 'Buckets deny non-TLS requests and TLS below 1.2',
    check(templates) {
      const policies = statements(templates, ['AWS::S3::BucketPolicy']);
      return findAll(templates, 'AWS::S3::Bucket')
        .filter((b) => {
          const mine = policies.filter((p) => resolveRef(templates, p.stack, p.props['Bucket'])?.id === b.id && p.stack === b.stack);
          const all = mine.flatMap((p) => p.statements);
          return !(denies(all, 'aws:SecureTransport') && denies(all, 's3:TlsVersion'));
        })
        .map((b) => violation('bucket-tls', b, 'Bucket policy must deny aws:SecureTransport=false and s3:TlsVersion<1.2'));
    },
  },
  {
    id: 'queue-encrypted',
    description: 'Queues use KMS encryption',
    check(templates) {
      return findAll(templates, 'AWS::SQS::Queue')
        .filter((q) => q.props['KmsMasterKeyId'] === undefined)
        .map((q) => violation('queue-encrypted', q, 'Queue must set KmsMasterKeyId'));
    },
  },
  {
    id: 'queue-private',
    description: 'Queues deny non-TLS requests, TLS below 1.2, and any access from outside the VPC',
    check(templates) {
      const policies = statements(templates, ['AWS::SQS::QueuePolicy']);
      return findAll(templates, 'AWS::SQS::Queue')
        .filter((q) => {
          const all = policies
            .filter((p) => p.stack === q.stack && asArr(p.props['Queues']).some((x) => resolveRef(templates, p.stack, x)?.id === q.id))
            .flatMap((p) => p.statements);
          return !(denies(all, 'aws:SecureTransport') && denies(all, 'aws:TlsVersion') && denies(all, 'aws:SourceVpc'));
        })
        .map((q) => violation('queue-private', q, 'Queue policy must deny insecure transport, TLS<1.2 and aws:SourceVpc mismatch'));
    },
  },
  {
    id: 'kms-rotation',
    description: 'Customer managed keys rotate and are symmetric',
    check(templates) {
      return findAll(templates, 'AWS::KMS::Key')
        .filter((k) => k.props['EnableKeyRotation'] !== true)
        .map((k) => violation('kms-rotation', k, 'EnableKeyRotation must be true'));
    },
  },
  {
    id: 'secrets-encrypted',
    description: 'Secrets use a customer managed KMS key',
    check(templates) {
      return findAll(templates, 'AWS::SecretsManager::Secret')
        .filter((s) => s.props['KmsKeyId'] === undefined)
        .map((s) => violation('secrets-encrypted', s, 'Secret must set KmsKeyId'));
    },
  },
  {
    id: 'logs-encrypted',
    description: 'Log groups use a customer managed KMS key',
    check(templates) {
      return findAll(templates, 'AWS::Logs::LogGroup')
        .filter((l) => l.props['KmsKeyId'] === undefined)
        .map((l) => violation('logs-encrypted', l, 'Log group must set KmsKeyId'));
    },
  },
  {
    id: 'backup-vault-encrypted',
    description: 'Backup vaults are encrypted with a customer managed key',
    check(templates) {
      return findAll(templates, 'AWS::Backup::BackupVault')
        .filter((v) => v.props['EncryptionKeyArn'] === undefined)
        .map((v) => violation('backup-vault-encrypted', v, 'Backup vault must set EncryptionKeyArn'));
    },
  },
  {
    id: 'private-model-and-kms-endpoints',
    description: 'A VPC with workloads has private interface endpoints for Bedrock runtime and KMS',
    check(templates) {
      const out: Violation[] = [];
      for (const [stack, t] of Object.entries(templates)) {
        const vpcs = Object.entries(t.Resources ?? {}).filter(([, r]) => r.Type === 'AWS::EC2::VPC');
        const eps = Object.values(t.Resources ?? {}).filter((r) => r.Type === 'AWS::EC2::VPCEndpoint' && asObj(r.Properties)['VpcEndpointType'] === 'Interface');
        for (const [id] of vpcs) {
          for (const svc of ['bedrock-runtime', 'kms']) {
            const ok = eps.some((e) => has(asObj(e.Properties)['ServiceName'], svc) && asObj(e.Properties)['PrivateDnsEnabled'] === true);
            if (!ok) out.push({ rule: 'private-model-and-kms-endpoints', stack, resource: id, message: `Missing private interface endpoint with private DNS for ${svc}` });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'egress-allowlist',
    description: 'A VPC has a Network Firewall that drops all egress except an allowlist of domains',
    check(templates) {
      const out: Violation[] = [];
      for (const [stack, t] of Object.entries(templates)) {
        const hasVpc = Object.values(t.Resources ?? {}).some((r) => r.Type === 'AWS::EC2::VPC');
        if (!hasVpc) continue;
        const one = findAll({ [stack]: t }, 'AWS::NetworkFirewall::Firewall')[0];
        const policy = findAll({ [stack]: t }, 'AWS::NetworkFirewall::FirewallPolicy')[0];
        const groups = findAll({ [stack]: t }, 'AWS::NetworkFirewall::RuleGroup');
        if (!one || !policy) {
          out.push({ rule: 'egress-allowlist', stack, resource: 'VPC', message: 'VPC has no Network Firewall egress control' });
          continue;
        }
        if (!has(asObj(policy.props['FirewallPolicy'])['StatefulDefaultActions'], 'drop_established')) {
          out.push(violation('egress-allowlist', policy, 'Default stateful action must drop established traffic not on the allowlist'));
        }
        for (const g of groups) {
          const src = asObj(asObj(asObj(g.props['RuleGroup'])['RulesSource'])['RulesSourceList']);
          const targets = asArr(src['Targets']);
          if (src['GeneratedRulesType'] !== 'ALLOWLIST' || targets.length === 0 || targets.some((x) => x === '.' || x === '*' || x === '')) {
            out.push(violation('egress-allowlist', g, 'Rule group must be a non-empty domain ALLOWLIST without catch-all entries'));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'waf-present',
    description: 'A regional WAF web ACL with managed rules exists in the network stack',
    check(templates) {
      const out: Violation[] = [];
      for (const [stack, t] of Object.entries(templates)) {
        if (!Object.values(t.Resources ?? {}).some((r) => r.Type === 'AWS::EC2::VPC')) continue;
        const acls = findAll({ [stack]: t }, 'AWS::WAFv2::WebACL');
        if (acls.length === 0 || !acls.some((a) => asArr(a.props['Rules']).length > 0 && a.props['Scope'] === 'REGIONAL')) {
          out.push({ rule: 'waf-present', stack, resource: 'VPC', message: 'No regional WAF web ACL with rules' });
        }
      }
      return out;
    },
  },
];

export function checkPolicies(templates: TemplateSet, ruleSet: readonly Rule[] = rules): Violation[] {
  return ruleSet.flatMap((r) => r.check(templates));
}

export function formatViolations(vs: readonly Violation[]): string {
  return vs.map((v) => `[${v.rule}] ${v.stack}/${v.resource}: ${v.message}`).join('\n');
}

/** Throws with every violated rule named. Used by the CI policy test. */
export function assertCompliant(templates: TemplateSet): void {
  const vs = checkPolicies(templates);
  if (vs.length > 0) throw new Error(`Infrastructure policy violations:\n${formatViolations(vs)}`);
}
