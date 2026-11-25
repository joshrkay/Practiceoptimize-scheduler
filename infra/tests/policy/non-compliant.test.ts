import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { describe, expect, it } from 'vitest';
import { assertCompliant, checkPolicies, formatViolations } from '../../policy/rules.js';
import { toSet } from '../helpers.js';

/** A deliberately bad stack: everything the policy checks exist to stop. */
function badStack(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'bad', { env: { account: '111111111111', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 }); // default: public subnets that map public IPs
  new rds.DatabaseInstance(stack, 'Db', {
    engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    publiclyAccessible: true,
    storageEncrypted: false,
    backupRetention: cdk.Duration.days(1),
  });
  new s3.Bucket(stack, 'Open', { encryption: s3.BucketEncryption.UNENCRYPTED });
  new sqs.Queue(stack, 'Queue', { encryption: sqs.QueueEncryption.UNENCRYPTED });
  const sg = new ec2.SecurityGroup(stack, 'Sg', { vpc });
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432));
  return Template.fromStack(stack);
}

describe('policy checks reject a non-compliant stack', () => {
  const set = toSet({ bad: badStack() });
  const violated = new Set(checkPolicies(set).map((v) => v.rule));

  it.each([
    'no-public-database',
    'database-encrypted',
    'database-tls',
    'no-public-subnets',
    'no-open-ingress',
    'bucket-encrypted',
    'bucket-private',
    'bucket-tls',
    'queue-encrypted',
    'queue-private',
    'private-model-and-kms-endpoints',
    'egress-allowlist',
    'waf-present',
  ])('flags %s', (rule) => {
    expect(violated.has(rule)).toBe(true);
  });

  it('fails CI with the violated rules named', () => {
    expect(() => assertCompliant(set)).toThrow(/\[no-public-database\] bad\/Db/);
    expect(() => assertCompliant(set)).toThrow(/\[bucket-encrypted\]/);
  });

  it('formats one line per violation', () => {
    const vs = checkPolicies(set);
    expect(formatViolations(vs).split('\n')).toHaveLength(vs.length);
  });
});

describe('individual rule edge cases', () => {
  const rule = (tpl: object) => checkPolicies({ t: tpl as never }).map((v) => v.rule);

  it('flags missing KMS rotation, unencrypted secrets, logs and backup vaults', () => {
    const v = rule({
      Resources: {
        K: { Type: 'AWS::KMS::Key', Properties: {} },
        S: { Type: 'AWS::SecretsManager::Secret', Properties: {} },
        L: { Type: 'AWS::Logs::LogGroup', Properties: {} },
        B: { Type: 'AWS::Backup::BackupVault', Properties: {} },
      },
    });
    expect(v).toEqual(expect.arrayContaining(['kms-rotation', 'secrets-encrypted', 'logs-encrypted', 'backup-vault-encrypted']));
  });

  it('flags a catch-all egress allowlist and a permissive default action', () => {
    const v = rule({
      Resources: {
        Vpc: { Type: 'AWS::EC2::VPC' },
        Fw: { Type: 'AWS::NetworkFirewall::Firewall', Properties: {} },
        Pol: { Type: 'AWS::NetworkFirewall::FirewallPolicy', Properties: { FirewallPolicy: { StatefulDefaultActions: ['aws:alert_established'] } } },
        Rg: {
          Type: 'AWS::NetworkFirewall::RuleGroup',
          Properties: { RuleGroup: { RulesSource: { RulesSourceList: { GeneratedRulesType: 'ALLOWLIST', Targets: ['.'] } } } },
        },
      },
    });
    expect(v.filter((r) => r === 'egress-allowlist')).toHaveLength(2);
  });

  it('flags security group ingress resources open to IPv6', () => {
    expect(rule({ Resources: { I: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { CidrIpv6: '::/0' } } } })).toContain('no-open-ingress');
  });

  it('flags a database subnet group whose subnets cannot be resolved to the data tier', () => {
    const v = rule({
      Resources: {
        G: { Type: 'AWS::RDS::DBSubnetGroup', Properties: { SubnetIds: [{ 'Fn::ImportValue': 'nowhere' }, { Ref: 'Missing' }] } },
      },
    });
    expect(v.filter((r) => r === 'no-public-database')).toHaveLength(2);
  });

  it('passes an empty template', () => {
    expect(rule({})).toEqual([]);
  });
});
