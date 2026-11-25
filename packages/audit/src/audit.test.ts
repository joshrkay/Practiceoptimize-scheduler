import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AuditWriteError,
  InMemoryAuditSink,
  REDACTED,
  auditRetentionYears,
  hashInputs,
  recordAudit,
  scrubText,
  scrubValue,
  withAudit,
  type AuditEventInput,
} from './index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/audit/synthetic-events.json', import.meta.url), 'utf8'),
) as { patient: { name: string; dob: string; memberId: string }; logLine: string; toolCall: AuditEventInput };

const fixedNow = () => new Date('2026-01-02T03:04:05.000Z');

describe('audit log', () => {
  it('records an event with all required fields and no raw inputs', async () => {
    const sink = new InMemoryAuditSink();
    const event = await recordAudit(sink, fixture.toolCall, fixedNow);
    expect(sink.events).toEqual([event]);
    expect(event).toMatchObject({
      practiceId: 'practice-podiatry-001',
      locationId: 'loc-asc-main',
      actor: { type: 'agent', id: 'scheduler-agent' },
      action: 'availity.eligibility.check',
      target: { type: 'case', id: 'case-0001' },
      result: 'success',
      autonomyTier: 1,
      approverId: null,
      externalTransactionId: 'GTID-SYNTH-0001',
      occurredAt: '2026-01-02T03:04:05.000Z',
    });
    expect(event.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect('inputs' in event).toBe(false);
  });

  it('events are frozen and the sink exposes no mutation path', async () => {
    const sink = new InMemoryAuditSink();
    const event = await recordAudit(sink, fixture.toolCall);
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event as { action: string }).action = 'x';
    }).toThrow();
    (sink.events as unknown[]).length = 0;
    expect(sink.events).toHaveLength(1);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(sink) as object).sort()).toEqual(
      ['append', 'constructor', 'events', 'failWith'].sort(),
    );
  });

  it('hashes inputs canonically', () => {
    expect(hashInputs({ a: 1, b: [1, { d: 2, c: 3 }] })).toBe(hashInputs({ b: [1, { c: 3, d: 2 }], a: 1 }));
    expect(hashInputs({ a: 1 })).not.toBe(hashInputs({ a: 2 }));
    expect(hashInputs(undefined)).toBe(hashInputs(null));
    expect(hashInputs('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a failed audit write fails the action result', async () => {
    const sink = new InMemoryAuditSink();
    sink.failWith(new Error('disk full'));
    await expect(recordAudit(sink, fixture.toolCall)).rejects.toBeInstanceOf(AuditWriteError);
    await expect(
      withAudit(sink, fixture.toolCall, () => Promise.resolve({ value: 'done' })),
    ).rejects.toThrow(AuditWriteError);
    sink.failWith(null);
    await expect(
      withAudit(sink, fixture.toolCall, () => Promise.resolve({ value: 'done' })),
    ).resolves.toBe('done');
  });

  it('withAudit records success with the external transaction id', async () => {
    const sink = new InMemoryAuditSink();
    const { externalTransactionId: _drop, ...base } = fixture.toolCall;
    void _drop;
    const value = await withAudit(sink, base, () =>
      Promise.resolve({ value: 42, externalTransactionId: 'GTID-2' }),
    );
    expect(value).toBe(42);
    expect(sink.events[0]).toMatchObject({ result: 'success', externalTransactionId: 'GTID-2' });
    await withAudit(sink, base, () => Promise.resolve({ value: 1 }));
    expect(sink.events[1]?.externalTransactionId).toBeNull();
  });

  it('withAudit records failure and rethrows the original error', async () => {
    const sink = new InMemoryAuditSink();
    const boom = new Error('boom');
    await expect(withAudit(sink, fixture.toolCall, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(sink.events[0]).toMatchObject({ result: 'failure' });
  });

  it('withAudit lets an audit failure win over an action failure', async () => {
    const sink = new InMemoryAuditSink();
    sink.failWith(new Error('down'));
    await expect(
      withAudit(sink, fixture.toolCall, () => Promise.reject(new Error('boom'))),
    ).rejects.toBeInstanceOf(AuditWriteError);
  });

  it('reads retention years from env with a default of 6', () => {
    expect(auditRetentionYears({})).toBe(6);
    expect(auditRetentionYears({ AUDIT_RETENTION_YEARS: '7' })).toBe(7);
    expect(auditRetentionYears({ AUDIT_RETENTION_YEARS: 'abc' })).toBe(6);
    expect(auditRetentionYears({ AUDIT_RETENTION_YEARS: '0' })).toBe(6);
    expect(auditRetentionYears()).toBeGreaterThan(0);
  });
});

describe('PHI scrubber', () => {
  it('redacts name, DOB and member id in a log line', () => {
    const out = scrubText(fixture.logLine);
    expect(out).not.toContain(fixture.patient.name);
    expect(out).not.toContain(fixture.patient.dob);
    expect(out).not.toContain(fixture.patient.memberId);
    expect(out).toContain(REDACTED);
    expect(out).toContain('Checking eligibility');
  });

  it('redacts known values wherever they appear, case-insensitively', () => {
    const out = scrubText('saw testy footman today (Footman, Testy)', {
      knownValues: ['Testy Footman', '   ', 'Footman'],
    });
    expect(out).toBe(`saw ${REDACTED} today (${REDACTED}, Testy)`);
  });

  it('redacts unlabelled shapes', () => {
    const out = scrubText(
      'ssn 123-45-6789 born 1961-03-14 or 3/14/1961 mail a.b@example.com call (555) 123-4567',
    );
    expect(out).not.toMatch(/123-45-6789|1961|example\.com|555/);
  });

  it('scrubs nested structured data without mutating the input', () => {
    const cyc: Record<string, unknown> = { note: 'DOB: 1961-03-14' };
    cyc['self'] = cyc;
    const input = {
      patient: { name: 'Testy Footman', dob: '1961-03-14', visits: 3, nothing: null },
      list: ['member id ZZX9900123', 7],
      at: new Date(0),
      err: new Error('bad member id ZZX9900123'),
      cyc,
    };
    const out = scrubValue(input);
    expect(out.patient).toEqual({ name: REDACTED, dob: REDACTED, visits: 3, nothing: null });
    expect(out.list).toEqual([`member id ${REDACTED}`, 7]);
    expect(out.at).toBeInstanceOf(Date);
    expect(out.err).toEqual({ name: 'Error', message: `bad member id ${REDACTED}` });
    expect((out.cyc as { self: unknown }).self).toBe('[Circular]');
    expect(input.patient.name).toBe('Testy Footman');
  });
});
