import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../lib/config.js';

export interface KmsStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Platform keys, one purpose each, all symmetric AES-256 with annual rotation.
 * Per-practice keys are created by the key-management service (RAH-11) under these accounts' policies.
 */
export class KmsStack extends cdk.Stack {
  readonly dataKey: kms.Key;
  readonly secretsKey: kms.Key;
  readonly logsKey: kms.Key;
  readonly backupKey: kms.Key;

  constructor(scope: Construct, id: string, props: KmsStackProps) {
    super(scope, id, props);
    const env = props.config.name;
    const mk = (name: string, description: string): kms.Key =>
      new kms.Key(this, name, {
        alias: `alias/scheduler-${env}-${name.toLowerCase()}`,
        description,
        enableKeyRotation: true,
        keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
        keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
        pendingWindow: cdk.Duration.days(30),
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

    this.dataKey = mk('Data', `Database, queue and object storage encryption (${env})`);
    this.secretsKey = mk('Secrets', `Secrets Manager encryption (${env})`);
    this.logsKey = mk('Logs', `CloudWatch Logs encryption (${env})`);
    this.backupKey = mk('Backup', `AWS Backup vault encryption (${env})`);

    this.logsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:*` },
        },
      }),
    );
  }
}
