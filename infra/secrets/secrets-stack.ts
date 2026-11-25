import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../lib/config.js';

export interface SecretsStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly secretsKeyArn: string;
}

/** Secrets Manager path for a practice's credentials: scheduler/<env>/practices/<practiceId>/... */
export function practiceVaultPrefix(env: string): string {
  return `scheduler/${env}/practices/`;
}

/**
 * Defines the vault namespace and the read policy for it. No secret values are created here:
 * practice credentials are written at runtime by the key-management service (RAH-11), and
 * dev and staging never hold real credentials or PHI.
 */
export class SecretsStack extends cdk.Stack {
  readonly vaultReadPolicy: iam.ManagedPolicy;
  readonly vaultPrefix: string;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props);
    this.vaultPrefix = practiceVaultPrefix(props.config.name);

    this.vaultReadPolicy = new iam.ManagedPolicy(this, 'PracticeVaultRead', {
      managedPolicyName: `scheduler-${props.config.name}-practice-vault-read`,
      statements: [
        new iam.PolicyStatement({
          sid: 'ReadPracticeSecrets',
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: [`arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:${this.vaultPrefix}*`],
        }),
        new iam.PolicyStatement({
          sid: 'DecryptViaSecretsManagerOnly',
          actions: ['kms:Decrypt'],
          resources: [props.secretsKeyArn],
          conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` } },
        }),
      ],
    });

    new cdk.CfnOutput(this, 'VaultPrefix', { value: this.vaultPrefix });
  }
}
