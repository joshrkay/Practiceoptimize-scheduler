import type { FlowState, QuoteTask, RefundFlag } from './flow.js';
import type {
  DepositLinkPort,
  FinancialConsentPort,
  FlowStore,
  PatientMessagePort,
  PatientPagePort,
  StaffWorkPort,
} from './ports.js';

/** In-memory fakes for tests and local wiring. */
export class InMemoryFlowStore implements FlowStore {
  private readonly rows = new Map<string, FlowState>();
  get(practiceId: string, caseId: string): Promise<FlowState | null> {
    return Promise.resolve(this.rows.get(`${practiceId}/${caseId}`) ?? null);
  }
  save(state: FlowState): Promise<void> {
    this.rows.set(`${state.practiceId}/${state.caseId}`, state);
    return Promise.resolve();
  }
}

export class FakeFinancialPorts
  implements FinancialConsentPort, PatientPagePort, PatientMessagePort, DepositLinkPort, StaffWorkPort
{
  readonly calls: string[] = [];
  readonly quoteTasks: QuoteTask[] = [];
  readonly refundFlags: RefundFlag[] = [];

  requestFinancialConsent(): Promise<void> {
    this.calls.push('consent');
    return Promise.resolve();
  }
  publishQuote(): Promise<void> {
    this.calls.push('page:quote');
    return Promise.resolve();
  }
  publishDepositLink(): Promise<void> {
    this.calls.push('page:deposit_link');
    return Promise.resolve();
  }
  notify(args: { template: string }): Promise<void> {
    this.calls.push(`message:${args.template}`);
    return Promise.resolve();
  }
  createDepositLink(args: { caseId: string; amountCents: number }): Promise<{ url: string }> {
    this.calls.push(`link:${args.amountCents}`);
    return Promise.resolve({ url: `https://pay.example.test/${args.caseId}` });
  }
  createQuoteTask(task: QuoteTask): Promise<void> {
    this.quoteTasks.push(task);
    return Promise.resolve();
  }
  createRefundFlag(flag: RefundFlag): Promise<void> {
    this.refundFlags.push(flag);
    return Promise.resolve();
  }
}
