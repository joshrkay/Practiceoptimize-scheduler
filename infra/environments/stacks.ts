import type * as cdk from 'aws-cdk-lib';
import { DataStack } from '../data/data-stack.js';
import { KmsStack } from '../kms/kms-stack.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { NetworkStack } from '../network/network-stack.js';
import { SecretsStack } from '../secrets/secrets-stack.js';

export interface SchedulerStacks {
  readonly kms: KmsStack;
  readonly network: NetworkStack;
  readonly secrets: SecretsStack;
  readonly data: DataStack;
  readonly all: readonly cdk.Stack[];
}

/** Builds the full set of stacks for one environment. dev, staging and prod all go through here. */
export function createSchedulerStacks(app: cdk.App, config: EnvironmentConfig, env?: cdk.Environment): SchedulerStacks {
  const prefix = `scheduler-${config.name}`;
  const common = { env, tags: { app: 'scheduler', environment: config.name, 'data-class': config.allowsPhi ? 'phi' : 'synthetic' } };

  const kms = new KmsStack(app, `${prefix}-kms`, { ...common, config });
  const network = new NetworkStack(app, `${prefix}-network`, { ...common, config, logsKey: kms.logsKey });
  const secrets = new SecretsStack(app, `${prefix}-secrets`, { ...common, config, secretsKeyArn: kms.secretsKey.keyArn });
  const data = new DataStack(app, `${prefix}-data`, {
    ...common,
    config,
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
    dataKeyArn: kms.dataKey.keyArn,
    secretsKeyArn: kms.secretsKey.keyArn,
    backupKeyArn: kms.backupKey.keyArn,
  });
  return { kms, network, secrets, data, all: [kms, network, secrets, data] };
}
