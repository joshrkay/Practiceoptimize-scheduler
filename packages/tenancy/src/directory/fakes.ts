import type {
  AuditSink,
  DeliveryStatus,
  EmailProvider,
  InBasketProvider,
  OutboundMessage,
  ProviderResult,
  SchedulerTask,
  SchedulerTaskPort,
  SendAuditEvent,
} from './ports';

class RecordingProvider {
  readonly sent: OutboundMessage[] = [];
  nextStatus: DeliveryStatus = 'queued';
  send(message: OutboundMessage): Promise<ProviderResult> {
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `fake-${this.sent.length}`, status: this.nextStatus });
  }
}

export class FakeEmailProvider extends RecordingProvider implements EmailProvider {}
export class FakeInBasketProvider extends RecordingProvider implements InBasketProvider {}

export class FakeAuditSink implements AuditSink {
  readonly events: SendAuditEvent[] = [];
  record(event: SendAuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export class FakeSchedulerTasks implements SchedulerTaskPort {
  readonly tasks: SchedulerTask[] = [];
  createTask(task: SchedulerTask): Promise<{ taskId: string }> {
    this.tasks.push(task);
    return Promise.resolve({ taskId: `task-${this.tasks.length}` });
  }
}
