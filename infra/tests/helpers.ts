import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { createSchedulerStacks, type SchedulerStacks } from '../environments/stacks.js';
import { configFor, type InfraEnv } from '../lib/config.js';
import type { CfnTemplate, TemplateSet } from '../policy/rules.js';

export interface Synthesized {
  stacks: SchedulerStacks;
  templates: Record<'kms' | 'network' | 'secrets' | 'data', Template>;
  set: TemplateSet;
}

export function synthEnvironment(name: InfraEnv, egress?: readonly string[]): Synthesized {
  const app = new cdk.App();
  const stacks = createSchedulerStacks(app, configFor(name, egress), { account: '111111111111', region: 'us-east-1' });
  const templates = {
    kms: Template.fromStack(stacks.kms),
    network: Template.fromStack(stacks.network),
    secrets: Template.fromStack(stacks.secrets),
    data: Template.fromStack(stacks.data),
  };
  const set = toSet({
    [stacks.kms.stackName]: templates.kms,
    [stacks.network.stackName]: templates.network,
    [stacks.secrets.stackName]: templates.secrets,
    [stacks.data.stackName]: templates.data,
  });
  return { stacks, templates, set };
}

export function toSet(byName: Record<string, Template>): TemplateSet {
  return Object.fromEntries(Object.entries(byName).map(([k, t]) => [k, t.toJSON() as CfnTemplate]));
}
