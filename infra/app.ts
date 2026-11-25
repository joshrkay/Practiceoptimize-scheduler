import * as cdk from 'aws-cdk-lib';
import { loadEnvironmentConfig } from './lib/config.js';
import { createSchedulerStacks } from './environments/stacks.js';

// INFRA_ENV selects dev, staging or prod. EGRESS_ALLOWLIST (comma separated domains) overrides the default.
const config = loadEnvironmentConfig();
const app = new cdk.App();
createSchedulerStacks(app, config, {
  account: process.env['CDK_DEFAULT_ACCOUNT'],
  region: process.env['CDK_DEFAULT_REGION'],
});
app.synth();
