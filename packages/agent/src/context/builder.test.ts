import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildContext, hasFieldPolicy, type CaseRecord } from './builder';
import { FIELD_POLICIES } from './field-policies';

const fixture = JSON.parse(
  readFileSync(new URL('../../../../tests/fixtures/cases/bunionectomy-insured.json', import.meta.url), 'utf8'),
) as CaseRecord;

describe('buildContext', () => {
  it('contains only the fields in the task policy', () => {
    const r = buildContext('draft_patient_instructions', fixture);
    if (!r.ok) throw new Error('expected ok');
    expect([...r.fields].sort()).toEqual([...FIELD_POLICIES.draft_patient_instructions].sort());
    const json = JSON.stringify(r.context);
    expect(json).not.toContain('Hallux');
    expect(json).not.toContain('000-00-0000');
    expect(r.context).not.toHaveProperty('diagnosisHistory');
    expect(r.context).toHaveProperty('patient.name', 'Pat Example');
    expect(r.context).not.toHaveProperty('patient.phone');
  });

  it('refuses an unknown task type', () => {
    expect(buildContext('mystery_task', fixture)).toEqual({
      ok: false,
      reason: 'unknown_task_type',
      taskType: 'mystery_task',
    });
    expect(buildContext('toString', fixture).ok).toBe(false);
    expect(hasFieldPolicy('toString')).toBe(false);
  });

  it('never includes an SSN, even nested in an allowed object', () => {
    for (const t of Object.keys(FIELD_POLICIES)) {
      const r = buildContext(t, fixture);
      expect(JSON.stringify(r)).not.toContain('000-00-0000');
    }
    const r = buildContext('draft_patient_instructions', {
      patient: { name: 'A', ssn: '123-45-6789' },
      prepRules: [{ rule: 'x', SSN: '123-45-6789' }],
      procedure: { date: 'd' },
    });
    expect(JSON.stringify(r)).not.toContain('123-45-6789');
    expect(JSON.stringify(r)).toContain('"rule":"x"');
  });

  it('skips missing fields and logs field names only', () => {
    const logs: { taskType: string; fields: string[] }[] = [];
    const r = buildContext(
      'schedule_confirmation',
      { patient: { name: 'Pat Example' }, facility: 5 },
      { logFieldSet: (e) => logs.push(e) },
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.fields).toEqual(['patient.name']);
    expect(logs).toEqual([{ taskType: 'schedule_confirmation', fields: ['patient.name'] }]);
    expect(JSON.stringify(logs)).not.toContain('Pat Example');
  });
});
