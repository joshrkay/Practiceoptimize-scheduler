import type * as cdk from 'aws-cdk-lib';
import { configFor } from '../../lib/config.js';
import { createSchedulerStacks } from '../stacks.js';

export const createDev = (app: cdk.App, env?: cdk.Environment, egress?: readonly string[]) =>
  createSchedulerStacks(app, configFor('dev', egress), env);
