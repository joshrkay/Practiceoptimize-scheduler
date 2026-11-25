import { describe, expect, it } from 'vitest';
import { approveChangePlan, buildChangePlan } from './plan.js';
import { executeChangePlan } from './execute.js';
import type { Approver, ChangePlan } from './model.js';
import type { FakeCascadeWorld } from './fakes.js';
import { loadFixture, type FixtureName } from './test-fixtures.js';

const ON = { featureEnabled: true };
const SCHEDULER: Approver = { type: 'human', userId: 'user-scheduler-01', role: 'scheduler' };

async function approved(name: FixtureName): Promise<{ plan: ChangePlan; world: FakeCascadeWorld }> {
  const { fixture, world } = loadFixture(name);
  const plan = await buildChangePlan(fixture.practiceId, fixture.change, world.planningPorts(), ON);
  return { plan: approveChangePlan(plan, SCHEDULER, world.nowIso), world };
}

interface TaskArgs {
  reason: string;
  requiresTakeOver: boolean;
  remainingSteps: { stepId: string }[];
}

describe('executeChangePlan guards', () => {
  it('refuses when the flag is off', async () => {
    const { plan, world } = await approved('site-change');
    await expect(executeChangePlan(plan, world.executionPorts(), { featureEnabled: false })).rejects.toMatchObject({
      code: 'feature_disabled',
    });
    expect(world.calls).toEqual([]);
  });

  it('refuses a completed plan', async () => {
    const { plan, world } = await approved('site-change');
    const done = await executeChangePlan(plan, world.executionPorts(), ON);
    await expect(executeChangePlan(done, world.executionPorts(), ON)).rejects.toMatchObject({ code: 'invalid_status' });
  });
});

describe('failures', () => {
  it('a failed external step pauses the plan and creates a task listing the remaining steps', async () => {
    const { plan, world } = await approved('date-move-outside-auth');
    world.failNext('authorization.resubmit');
    const paused = await executeChangePlan(plan, world.executionPorts(), ON);

    expect(paused.status).toBe('paused');
    const failed = paused.steps.find((s) => s.status === 'failed')!;
    expect(failed.action.kind).toBe('resubmit_authorization');
    expect(failed.results).toEqual([
      { attempt: 1, at: world.nowIso, ok: false, detail: 'authorization.resubmit unavailable (simulated)' },
    ]);
    // Steps after the failure did not run.
    expect(world.writesTo('messaging')).toEqual([]);
    const remaining = paused.steps.slice(paused.steps.indexOf(failed));
    expect(paused.tasks).toHaveLength(1);
    expect(paused.tasks[0]?.remainingStepIds).toEqual(remaining.map((s) => s.stepId));
    const task = world.writesTo('reviewQueue', 'createTask')[0]?.args as TaskArgs;
    expect(task.requiresTakeOver).toBe(false);
    expect(task.remainingSteps.map((s) => s.stepId)).toEqual(remaining.map((s) => s.stepId));

    // Resume: the failed step is retried and earlier steps are not repeated.
    const done = await executeChangePlan(paused, world.executionPorts(), ON);
    expect(done.status).toBe('completed');
    expect(done.steps.find((s) => s.stepId === failed.stepId)?.attempts).toBe(2);
    expect(world.writesTo('facility', 'update')).toHaveLength(1);
    expect(world.writesTo('caseState', 'transition')).toHaveLength(2);
  });

  it('stops after two failed attempts at an external step and asks a scheduler to take over', async () => {
    const { plan, world } = await approved('date-move-outside-auth');
    world.failNext('messaging.send', 2);
    const paused = await executeChangePlan(plan, world.executionPorts(), ON);
    expect(paused.status).toBe('paused');
    const stopped = await executeChangePlan(paused, world.executionPorts(), ON);

    expect(stopped.status).toBe('stopped');
    expect(stopped.tasks).toHaveLength(2);
    const lastTask = world.writesTo('reviewQueue', 'createTask')[1]?.args as TaskArgs;
    expect(lastTask.requiresTakeOver).toBe(true);
    expect(lastTask.reason).toContain('failed 2 times');
    await expect(executeChangePlan(stopped, world.executionPorts(), ON)).rejects.toMatchObject({ code: 'invalid_status' });
    expect(world.writesTo('messaging')).toEqual([]);
  });

  it('an internal step failure pauses but never stops the plan', async () => {
    const { plan, world } = await approved('date-move-outside-auth');
    world.failNext('readiness.reopen', 2);
    const first = await executeChangePlan(plan, world.executionPorts(), ON);
    const second = await executeChangePlan(first, world.executionPorts(), ON);
    expect(second.status).toBe('paused');
    const third = await executeChangePlan(second, world.executionPorts(), ON);
    expect(third.status).toBe('completed');
  });

  it('records non-Error throws as text', async () => {
    const { plan, world } = await approved('site-change');
    const ports = world.executionPorts();
    const paused = await executeChangePlan(
      plan,
      {
        ...ports,
        caseState: {
          transition: () => Promise.reject('state store offline'),
        },
      },
      ON,
    );
    expect(paused.status).toBe('paused');
    expect(paused.steps[0]?.results[0]?.detail).toBe('state store offline');
  });
});

describe('every step kind reaches its port', () => {
  it('cancellation steps call the cancel tools', async () => {
    const { plan, world } = await approved('cancellation');
    const done = await executeChangePlan(plan, world.executionPorts(), ON);
    expect(done.status).toBe('completed');
    expect(world.writesTo('coordination', 'cancelRequest')).toHaveLength(1);
    expect(world.writesTo('postOp', 'cancel')).toHaveLength(1);
    expect(world.writesTo('messaging', 'send')[0]?.args).toEqual({ template: 'case_cancelled' });
    expect(world.writesTo('ehr', 'updateCase')[0]?.args).toEqual({ cancelled: true });
    expect(done.steps.map((s) => s.results[0]?.detail)).toEqual([
      'Posting at asc-sunrise-foot cancelled.',
      'Request coord-rep-series-1 cancelled.',
      'Post-op visit appt-postop-series-1 cancelled.',
      expect.stringContaining('(case_cancelled)'),
      'EHR updated.',
      'Practice management updated.',
      'Slot slot-asc-20261210-0800 offered to the waitlist.',
      'Case returned to Cancelled.',
    ]);
  });
});
