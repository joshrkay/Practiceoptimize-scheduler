import { classifyKeypress, classifyReply, type Classification } from './classify.js';
import { CHANGE_NO_SLOTS_TEXT, changeLinkText, helpText, urgentInstructions } from './messages.js';
import type {
  CaseDirectory,
  CaseUpdates,
  Clock,
  InboundMessage,
  Messenger,
  OptOuts,
  PendingChangeStore,
  ReplyAudit,
  ReplyCase,
  ReplyClass,
  ReplyClassifier,
  ReplyFlags,
  ReviewQueue,
  SlotOffers,
  TaskQueue,
} from './ports.js';

export const CHANGE_PICK_WINDOW_HOURS = 24;

export interface ReplyDeps {
  cases: CaseDirectory;
  caseUpdates: CaseUpdates;
  messenger: Messenger;
  optOuts: OptOuts;
  tasks: TaskQueue;
  reviewQueue: ReviewQueue;
  slotOffers: SlotOffers;
  pending: PendingChangeStore;
  audit: ReplyAudit;
  flags: ReplyFlags;
  classifier: ReplyClassifier;
  clock: Clock;
}

export interface HandleResult {
  classification: ReplyClass;
  source: Classification['source'];
  action: string;
}

/** Thrown after the urgent path attempted every step and at least one failed, so the webhook retries. */
export class UrgentPathError extends Error {
  constructor(readonly causes: unknown[]) {
    super(`urgent reply handling had ${causes.length} failed step(s)`);
    this.name = 'UrgentPathError';
  }
}

async function handleUrgent(deps: ReplyDeps, msg: InboundMessage, c: ReplyCase | null): Promise<string> {
  // No flag, quiet-hours or classifier dependency here. Each step runs even if the other fails.
  const steps = await Promise.allSettled([
    deps.messenger.send({
      practiceId: msg.practiceId,
      to: msg.from,
      text: urgentInstructions(c?.surgeonOfficePhone ?? null),
      kind: 'urgent_instructions',
      safety: true,
    }),
    deps.tasks.createTask({
      practiceId: msg.practiceId,
      caseId: c?.caseId ?? null,
      kind: 'urgent_reply',
      priority: 'priority',
      summary: 'Urgent patient reply: possible emergency or new symptoms. Call the patient now.',
      patientWords: msg.body || undefined,
      dedupeKey: `urgent:${msg.providerMessageId}`,
    }),
  ]);
  const failures = steps.flatMap((s) => (s.status === 'rejected' ? [s.reason] : []));
  if (failures.length > 0) throw new UrgentPathError(failures);
  return 'urgent_instructions_sent_and_priority_task_created';
}

async function toScheduler(deps: ReplyDeps, msg: InboundMessage, c: ReplyCase | null, why: string): Promise<string> {
  await deps.tasks.createTask({
    practiceId: msg.practiceId,
    caseId: c?.caseId ?? null,
    kind: 'scheduler_reply',
    priority: 'normal',
    summary: `Patient reply needs a scheduler (${why}).`,
    patientWords: msg.body || (msg.digits ? `Keypress ${msg.digits}` : undefined),
    dedupeKey: `reply:${msg.providerMessageId}`,
  });
  return `scheduler_task:${why}`;
}

async function handleConfirm(deps: ReplyDeps, msg: InboundMessage, c: ReplyCase | null): Promise<string> {
  if (!c || !c.confirmationSentAt) return toScheduler(deps, msg, c, 'confirm_without_pending_confirmation');
  if (!c.confirmedAt) await deps.caseUpdates.markConfirmed(msg.practiceId, c.caseId, deps.clock.now());
  return 'case_confirmed';
}

async function handleChange(deps: ReplyDeps, msg: InboundMessage, c: ReplyCase | null): Promise<string> {
  if (!c) return toScheduler(deps, msg, c, 'change_request_without_case');
  const requestId = `chg:${msg.providerMessageId}`;
  const offer = await deps.slotOffers.proposeSlots(msg.practiceId, c.caseId, requestId);
  if (!offer || offer.slotIds.length < 3) {
    await deps.reviewQueue.submitChangeRequest({
      practiceId: msg.practiceId,
      caseId: c.caseId,
      requestId,
      patientWords: msg.body,
      reason: 'no_slots_available',
    });
    await deps.messenger.send({
      practiceId: msg.practiceId, to: msg.from, text: CHANGE_NO_SLOTS_TEXT, kind: 'change_no_slots', safety: false,
    });
    return 'change_request_queued_no_slots';
  }
  const expiresAt = new Date(deps.clock.now().getTime() + CHANGE_PICK_WINDOW_HOURS * 3_600_000);
  await deps.pending.add({
    requestId,
    practiceId: msg.practiceId,
    caseId: c.caseId,
    patientWords: msg.body,
    slotIds: offer.slotIds,
    expiresAt,
    status: 'open',
  });
  await deps.messenger.send({
    practiceId: msg.practiceId, to: msg.from, text: changeLinkText(offer.url), kind: 'change_link', safety: false,
  });
  return 'change_link_sent';
}

async function handleHelp(deps: ReplyDeps, msg: InboundMessage, c: ReplyCase | null): Promise<string> {
  if (!c?.locationPhone) return toScheduler(deps, msg, c, 'help_without_location_phone');
  await deps.messenger.send({
    practiceId: msg.practiceId, to: msg.from, text: helpText(c.locationPhone), kind: 'help', safety: false,
  });
  return 'help_sent';
}

async function dispatch(deps: ReplyDeps, msg: InboundMessage, c: ReplyCase | null, label: ReplyClass): Promise<string> {
  switch (label) {
    case 'urgent':
      return handleUrgent(deps, msg, c);
    case 'stop':
      await deps.optOuts.optOutAllChannels(msg.practiceId, msg.from, c?.patientId ?? null);
      return 'opted_out_all_channels';
    default:
      break;
  }
  // Everything else is off when the feature flag is off: the reply goes to a scheduler instead.
  if (!(await deps.flags.patientRepliesEnabled(msg.practiceId))) return toScheduler(deps, msg, c, 'replies_disabled');
  switch (label) {
    case 'confirm':
      return handleConfirm(deps, msg, c);
    case 'change_request':
      return handleChange(deps, msg, c);
    case 'help':
      return handleHelp(deps, msg, c);
    default:
      return toScheduler(deps, msg, c, 'other');
  }
}

/**
 * Handles one verified inbound reply. Never reschedules or cancels a case and never answers clinical
 * questions. Urgent and stop run regardless of the feature flag and quiet hours.
 */
export async function handleInboundReply(deps: ReplyDeps, msg: InboundMessage): Promise<HandleResult> {
  let c: ReplyCase | null = null;
  let caseLookupFailed = false;
  try {
    c = await deps.cases.findCaseForPatientNumber(msg.practiceId, msg.from);
  } catch {
    caseLookupFailed = true;
  }

  const classification: Classification =
    msg.channel === 'voice'
      ? { label: classifyKeypress(msg.digits ?? ''), source: 'keypress' }
      : await classifyReply(msg.body, deps.classifier);
  const label = classification.label;
  // Without the case link the urgent path still runs; other paths fall back to a scheduler task.
  const effective: ReplyClass = caseLookupFailed && label !== 'urgent' && label !== 'stop' ? 'other' : label;

  if (c) {
    // Best effort: recording the reply must never block handling (especially the urgent path).
    await deps.caseUpdates.recordReply(msg.practiceId, c.caseId, deps.clock.now()).catch(() => undefined);
  }

  const audit = (action: string): Promise<void> =>
    deps.audit
      .record({
        practiceId: msg.practiceId,
        caseId: c?.caseId ?? null,
        providerMessageId: msg.providerMessageId,
        channel: msg.channel,
        classification: effective,
        source: classification.source,
        action,
      })
      .catch(() => undefined); // an audit failure never masks or blocks handling

  let action: string;
  try {
    action = await dispatch(deps, msg, c, effective);
  } catch (error) {
    await audit('handling_failed');
    throw error;
  }
  await audit(action);
  return { classification: effective, source: classification.source, action };
}
