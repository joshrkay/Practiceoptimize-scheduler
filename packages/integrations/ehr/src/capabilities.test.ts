import { describe, expect, it } from 'vitest';
import { buildFakePractice, FAKE_PRACTICE, PATIENT_ID } from '../tests/support/fake-harness.js';
import {
  EHR_CAPABILITIES,
  InMemoryWorkspaceTaskSink,
  LocationSourceMap,
  PILOT_CAPABILITY_MATRIX,
  REDOX_OPERATIONS,
  ehrError,
  ok,
  resolveOrCreateTask,
  unsupported,
  withCapability,
} from './index.js';

describe('capability matrix', () => {
  it('lists every capability for every pilot EHR', () => {
    for (const row of Object.values(PILOT_CAPABILITY_MATRIX)) {
      expect(Object.keys(row).sort()).toEqual([...EHR_CAPABILITIES].sort());
    }
  });

  it('lists every capability in the Redox operation table', () => {
    expect(Object.keys(REDOX_OPERATIONS).sort()).toEqual([...EHR_CAPABILITIES].sort());
  });
});

describe('Scenario 2: capability gap becomes a workspace task', () => {
  it('reports the in-basket gap and the caller creates a workspace task instead', async () => {
    const { connector } = buildFakePractice();
    const ctx = { practiceId: FAKE_PRACTICE, locationId: 'loc-eclinicalworks', correlationId: 'corr-1' };
    const tasks = new InMemoryWorkspaceTaskSink();

    const result = await connector.sendInBasketMessage(ctx, {
      recipientId: 'dr-pool',
      patientId: PATIENT_ID,
      subject: 'Clearance',
      body: 'Synthetic message body.',
      idempotencyKey: 'msg-1',
    });
    expect(result).toMatchObject({ status: 'unsupported', capability: 'inbasket.send', reason: 'ehr_does_not_support' });

    const outcome = await resolveOrCreateTask(result, tasks);
    expect(outcome).toMatchObject({ outcome: 'task_created', taskId: 'task-1' });
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]?.task).toEqual({
      kind: 'ehr_capability_gap',
      practiceId: FAKE_PRACTICE,
      locationId: 'loc-eclinicalworks',
      capability: 'inbasket.send',
      ehr: 'eclinicalworks',
      title: 'Send the in-basket message in the EHR',
      instructions: expect.stringContaining('does not support "inbasket.send"'),
      subject: { patientId: PATIENT_ID },
      correlationId: 'corr-1',
    });
    expect(connector.writes(ctx).inBasket).toEqual([]);
  });

  it('passes successes and errors through without creating tasks', async () => {
    const tasks = new InMemoryWorkspaceTaskSink();
    expect(await resolveOrCreateTask(ok(42), tasks)).toEqual({ outcome: 'done', value: 42 });
    expect(await resolveOrCreateTask(ehrError('upstream_error', 'down', true), tasks)).toEqual({
      outcome: 'failed',
      code: 'upstream_error',
      retryable: true,
      message: 'down',
    });
    expect(tasks.tasks).toEqual([]);
  });

  it('words pending-verification tasks differently from EHR gaps', () => {
    const r = unsupported({ practiceId: 'p', locationId: 'l' }, 'nextgen', 'schedule.read', 'connector_pending_verification');
    expect(r.workspaceTask.instructions).toContain('not yet verified');
    expect(r.workspaceTask).not.toHaveProperty('subject');
    expect(r.workspaceTask).not.toHaveProperty('correlationId');
  });
});

describe('withCapability', () => {
  it('turns an unexpected exception into a PHI-free retryable upstream_error', async () => {
    const sources = new LocationSourceMap([
      { practiceId: 'p', locationId: 'l', ehr: 'athenahealth', redox: { destinationId: 'd', patientIdType: 'MR' } },
    ]);
    const result = await withCapability(sources, { practiceId: 'p', locationId: 'l' }, 'patient.read', async () => {
      throw new Error('Patient Jane Doe DOB 1960-01-01 broke');
    });
    expect(result).toEqual({
      status: 'error',
      code: 'upstream_error',
      retryable: true,
      message: 'The EHR call for "patient.read" failed unexpectedly.',
    });
  });
});

describe('LocationSourceMap', () => {
  const binding = (practiceId: string, locationId: string, ehr: 'athenahealth' | 'nextgen') => ({
    practiceId,
    locationId,
    ehr,
    redox: { destinationId: `d-${ehr}`, patientIdType: 'MR' },
  });

  it('maps one practice’s locations to different EHRs', () => {
    const map = new LocationSourceMap([binding('p1', 'office', 'athenahealth'), binding('p1', 'asc', 'nextgen')]);
    expect(map.resolve({ practiceId: 'p1', locationId: 'office' })?.ehr).toBe('athenahealth');
    expect(map.resolve({ practiceId: 'p1', locationId: 'asc' })?.ehr).toBe('nextgen');
    expect(map.locationsOf('p1').map((b) => b.locationId)).toEqual(['office', 'asc']);
  });

  it('never resolves a location across practices', () => {
    const map = new LocationSourceMap([binding('p1', 'shared-id', 'athenahealth'), binding('p2', 'shared-id', 'nextgen')]);
    expect(map.resolve({ practiceId: 'p2', locationId: 'shared-id' })?.ehr).toBe('nextgen');
    expect(map.resolve({ practiceId: 'p3', locationId: 'shared-id' })).toBeUndefined();
    expect(map.locationsOf('p1')).toHaveLength(1);
  });

  it('refuses a duplicate mapping for the same practice location', () => {
    const map = new LocationSourceMap([binding('p1', 'office', 'athenahealth')]);
    expect(() => map.register(binding('p1', 'office', 'nextgen'))).toThrow(/already mapped/);
  });

  it('applies per-location capability overrides on top of the matrix row', () => {
    const map = new LocationSourceMap([
      { ...binding('p1', 'office', 'athenahealth'), capabilityOverrides: { 'inbasket.send': 'supported', 'chart.write': 'unsupported' } },
    ]);
    const profile = map.profileFor(map.resolve({ practiceId: 'p1', locationId: 'office' })!);
    expect(profile['inbasket.send']).toBe('supported');
    expect(profile['chart.write']).toBe('unsupported');
    expect(profile['orders.read']).toBe('supported');
  });
});
