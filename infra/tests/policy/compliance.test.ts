import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { INFRA_ENVS } from '../../lib/config.js';
import { assertCompliant, checkPolicies, rules } from '../../policy/rules.js';
import { synthEnvironment } from '../helpers.js';

describe.each(INFRA_ENVS)('%s environment', (name) => {
  const { templates, set } = synthEnvironment(name);

  it('passes every policy rule', () => {
    expect(checkPolicies(set)).toEqual([]);
    expect(() => assertCompliant(set)).not.toThrow();
  });

  it('keeps the database private, encrypted and TLS-only', () => {
    templates.data.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      PubliclyAccessible: false,
      StorageEncrypted: true,
      KmsKeyId: Match.anyValue(),
      BackupRetentionPeriod: Match.anyValue(),
    });
    templates.data.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: Match.objectLike({ 'rds.force_ssl': '1', ssl_min_protocol_version: 'TLSv1.2' }),
    });
  });

  it('encrypts and privatizes storage and queues', () => {
    templates.data.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }) })] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    templates.data.resourcePropertiesCountIs('AWS::SQS::Queue', { KmsMasterKeyId: Match.anyValue() }, 2);
    templates.data.hasResourceProperties('AWS::Backup::BackupVault', { EncryptionKeyArn: Match.anyValue() });
  });

  it('puts the database in isolated data subnets and no subnet auto-assigns public IPs', () => {
    templates.network.resourcePropertiesCountIs('AWS::EC2::Subnet', { MapPublicIpOnLaunch: true }, 0);
    templates.network.hasResourceProperties('AWS::EC2::Subnet', {
      Tags: Match.arrayWith([{ Key: 'scheduler:subnet-tier', Value: 'data' }]),
    });
  });

  it('has private Bedrock and KMS endpoints, an egress allowlist and a WAF', () => {
    for (const svc of ['bedrock-runtime', 'kms']) {
      templates.network.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      });
      expect(JSON.stringify(templates.network.findResources('AWS::EC2::VPCEndpoint'))).toContain(svc);
    }
    templates.network.hasResourceProperties('AWS::NetworkFirewall::RuleGroup', {
      RuleGroup: Match.objectLike({ RulesSource: { RulesSourceList: Match.objectLike({ GeneratedRulesType: 'ALLOWLIST' }) } }),
    });
    templates.network.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
  });

  it('rotates every KMS key and holds no secret values outside the generated database credential', () => {
    templates.kms.resourcePropertiesCountIs('AWS::KMS::Key', { EnableKeyRotation: true }, 4);
    expect(Object.keys(templates.secrets.findResources('AWS::SecretsManager::Secret'))).toHaveLength(0);
  });
});

describe('environment differences', () => {
  it('prod is multi-AZ with deletion protection and 35 day backups; dev and staging are not', () => {
    synthEnvironment('prod').templates.data.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 35,
    });
    for (const n of ['dev', 'staging'] as const) {
      synthEnvironment(n).templates.data.hasResourceProperties('AWS::RDS::DBInstance', { MultiAZ: false, DeletionProtection: false });
    }
  });

  it('puts the configured domains on the egress allowlist', () => {
    const { templates } = synthEnvironment('dev', ['.availity.com', '.example-vendor.com']);
    templates.network.hasResourceProperties('AWS::NetworkFirewall::RuleGroup', {
      RuleGroup: Match.objectLike({ RulesSource: { RulesSourceList: Match.objectLike({ Targets: ['.availity.com', '.example-vendor.com'] }) } }),
    });
  });

  it('scopes the vault read policy to the environment practice path', () => {
    const { templates } = synthEnvironment('staging');
    expect(JSON.stringify(templates.secrets.toJSON())).toContain('scheduler/staging/practices/');
  });

  it('defines every rule with a unique id and description', () => {
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rules.every((r) => r.description.length > 0)).toBe(true);
  });
});
