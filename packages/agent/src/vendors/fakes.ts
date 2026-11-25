import type {
  ApprovalQueuePort,
  ClockPort,
  CoordinationPort,
  FacilityInfo,
  FacilityRulesPort,
  SchedulerAlertPort,
  SurgeonPreferencesPort,
  VendorDirectoryPort,
  VendorRequestStore,
} from './ports.js';
import type { VendorMessage, VendorRep, VendorRequestRecord } from './types.js';

export class FakeCoordination implements CoordinationPort {
  readonly sent: VendorMessage[] = [];
  send(message: VendorMessage): Promise<{ coordinationRequestId: string }> {
    this.sent.push(message);
    return Promise.resolve({ coordinationRequestId: `coord-${String(this.sent.length)}` });
  }
}

export class FakePreferences implements SurgeonPreferencesPort {
  constructor(private readonly reps: Record<string, VendorRep> = {}) {}
  preferredRep(_p: string, surgeonId: string): Promise<VendorRep | null> {
    return Promise.resolve(this.reps[surgeonId] ?? null);
  }
}

export class FakeDirectory implements VendorDirectoryPort {
  constructor(private readonly rep: VendorRep | null = null) {}
  findRep(): Promise<VendorRep | null> {
    return Promise.resolve(this.rep);
  }
}

export class FakeFacilities implements FacilityRulesPort {
  constructor(private readonly byId: Record<string, FacilityInfo>) {}
  get(_p: string, facilityId: string): Promise<FacilityInfo> {
    const f = this.byId[facilityId];
    return f ? Promise.resolve(f) : Promise.reject(new Error(`unknown facility ${facilityId}`));
  }
}

export class FakeApprovals implements ApprovalQueuePort {
  readonly items: Parameters<ApprovalQueuePort['enqueue']>[0][] = [];
  enqueue(item: Parameters<ApprovalQueuePort['enqueue']>[0]): Promise<void> {
    this.items.push(item);
    return Promise.resolve();
  }
}

export class FakeAlerts implements SchedulerAlertPort {
  readonly flags: Parameters<SchedulerAlertPort['flag']>[0][] = [];
  flag(alert: Parameters<SchedulerAlertPort['flag']>[0]): Promise<void> {
    this.flags.push(alert);
    return Promise.resolve();
  }
}

export class FakeClock implements ClockPort {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(d: Date): void {
    this.current = d;
  }
}

/** Index into an array, failing loudly when absent (tests run with noUncheckedIndexedAccess). */
export function nth<T>(items: readonly T[], i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no item at index ${String(i)}`);
  return v;
}

export class InMemoryVendorStore implements VendorRequestStore {
  private readonly rows = new Map<string, VendorRequestRecord>();
  save(record: VendorRequestRecord): Promise<void> {
    this.rows.set(record.id, structuredClone(record));
    return Promise.resolve();
  }
  get(id: string): Promise<VendorRequestRecord | null> {
    const r = this.rows.get(id);
    return Promise.resolve(r ? structuredClone(r) : null);
  }
  findLiveByCase(practiceId: string, caseId: string): Promise<VendorRequestRecord | null> {
    for (const r of this.rows.values()) {
      if (r.practiceId === practiceId && r.caseId === caseId && r.status !== 'cancelled') {
        return Promise.resolve(structuredClone(r));
      }
    }
    return Promise.resolve(null);
  }
  listLive(practiceId: string): Promise<VendorRequestRecord[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.practiceId === practiceId && r.status !== 'cancelled')
        .map((r) => structuredClone(r)),
    );
  }
}
