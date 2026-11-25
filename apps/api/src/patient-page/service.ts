import { generateToken, parseToken, safeEqual, secretMatches } from './tokens.js';
import { toPatientCaseView, type PatientCaseView } from './view-model.js';
import {
  MESSAGE_TYPES,
  type AuditPort,
  type AuthorizedContact,
  type CaseId,
  type CaseReadPort,
  type ChangePlanPort,
  type Clock,
  type ContactPreferencesPort,
  type FinancialLinks,
  type FinancialLinksPort,
  type LinkDeliveryPort,
  type Locale,
  type MessageType,
  type PatientIdentityPort,
  type PatientLinkRecord,
  type PatientLinkStore,
  type PatientSessionRecord,
  type PatientSessionStore,
  type PracticeId,
  type ProposedSlot,
  type SchedulerNotificationPort,
  type SlotProposalPort,
} from './ports.js';

export interface PatientPageConfig {
  /** `PATIENT_LINK_TTL_HOURS`, default 72. */
  linkTtlHours: number;
  sessionTtlMinutes: number;
  maxFailedAttempts: number;
  /** Minimum gap between automatic re-issues for one case. */
  newLinkCooldownMinutes: number;
  /** Public origin used to build links, e.g. https://care.example.com */
  baseUrl: string;
}

export const DEFAULT_CONFIG: Omit<PatientPageConfig, 'baseUrl'> = {
  linkTtlHours: 72,
  sessionTtlMinutes: 30,
  maxFailedAttempts: 5,
  newLinkCooldownMinutes: 10,
};

export function configFromEnv(
  env: Record<string, string | undefined>,
  baseUrl: string,
): PatientPageConfig {
  const parsed = Number(env['PATIENT_LINK_TTL_HOURS']);
  const linkTtlHours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONFIG.linkTtlHours;
  return { ...DEFAULT_CONFIG, linkTtlHours, baseUrl };
}

export interface PatientPageDependencies {
  links: PatientLinkStore;
  sessions: PatientSessionStore;
  identity: PatientIdentityPort;
  cases: CaseReadPort;
  contacts: ContactPreferencesPort;
  slots: SlotProposalPort;
  changePlans: ChangePlanPort;
  financial: FinancialLinksPort;
  audit: AuditPort;
  scheduler: SchedulerNotificationPort;
  delivery: LinkDeliveryPort;
  clock: Clock;
}

export type LinkUnavailableReason = 'invalid' | 'expired' | 'used' | 'locked';

export type InspectResult =
  | { status: 'needs_verification' }
  | { status: 'unavailable'; reason: LinkUnavailableReason };

export type VerifyResult =
  | { status: 'verified'; sessionToken: string; expiresAt: Date }
  | { status: 'wrong_dob'; attemptsRemaining: number }
  | { status: 'unavailable'; reason: LinkUnavailableReason };

export interface ViewOptions {
  locale?: Locale;
  includeSlots?: boolean;
}

export interface PatientPageData {
  view: PatientCaseView;
  contacts: AuthorizedContact[];
  /** At most three, only when the patient asked to reschedule. */
  proposedSlots: ProposedSlot[] | null;
  /** Links out only; null for insured cases. */
  financial: FinancialLinks | null;
}

export type ViewResult = { status: 'ok'; data: PatientPageData } | { status: 'session_expired' };

export type ActionResult =
  | { status: 'ok' }
  | { status: 'session_expired' }
  | { status: 'rejected' };

export type ChooseSlotResult =
  | { status: 'requested'; changePlanId: string }
  | { status: 'session_expired' }
  | { status: 'rejected' };

const DOB_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_LIMIT = 3;

function isHttps(url: string | null): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export class PatientPageService {
  constructor(
    private readonly deps: PatientPageDependencies,
    private readonly config: PatientPageConfig,
  ) {}

  /** Issues a link for a case. The token is returned once, for the message sender. */
  async issueLink(input: {
    practiceId: PracticeId;
    caseId: CaseId;
  }): Promise<{ token: string; url: string; expiresAt: Date }> {
    const now = this.deps.clock.now();
    const generated = generateToken();
    const expiresAt = new Date(now.getTime() + this.config.linkTtlHours * 3_600_000);
    await this.deps.links.insert({
      id: generated.id,
      practiceId: input.practiceId,
      caseId: input.caseId,
      secretHash: generated.secretHash,
      createdAt: now,
      expiresAt,
      usedAt: null,
      failedAttempts: 0,
      lockedAt: null,
    });
    await this.deps.audit.record({
      practiceId: input.practiceId,
      caseId: input.caseId,
      action: 'patient_link.issued',
      outcome: 'success',
      at: now,
      actor: { kind: 'patient_link', linkId: generated.id },
    });
    return {
      token: generated.token,
      url: `${this.config.baseUrl}/p/${generated.token}`,
      expiresAt,
    };
  }

  /** Looks the link up and checks the secret in constant time. Never reveals case data. */
  private async resolveLink(token: string): Promise<PatientLinkRecord | null> {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const link = await this.deps.links.findById(parsed.id);
    if (!link || !secretMatches(parsed.secret, link.secretHash)) return null;
    return link;
  }

  private statusOf(link: PatientLinkRecord): LinkUnavailableReason | null {
    if (link.lockedAt) return 'locked';
    if (link.usedAt) return 'used';
    if (link.expiresAt.getTime() <= this.deps.clock.now().getTime()) return 'expired';
    return null;
  }

  async inspectLink(token: string): Promise<InspectResult> {
    const link = await this.resolveLink(token);
    if (!link) return { status: 'unavailable', reason: 'invalid' };
    const reason = this.statusOf(link);
    return reason ? { status: 'unavailable', reason } : { status: 'needs_verification' };
  }

  async verify(token: string, dateOfBirth: string): Promise<VerifyResult> {
    const link = await this.resolveLink(token);
    if (!link) return { status: 'unavailable', reason: 'invalid' };
    const now = this.deps.clock.now();
    const reason = this.statusOf(link);
    if (reason) {
      await this.auditLink(link, 'patient_link.rejected', 'failure', { reason });
      return { status: 'unavailable', reason };
    }

    const onFile = await this.deps.identity.getDateOfBirth(link.practiceId, link.caseId);
    const matches =
      onFile !== null && DOB_PATTERN.test(dateOfBirth) && safeEqual(onFile, dateOfBirth);

    if (!matches) {
      const failures = await this.deps.links.recordFailedAttempt(link.id);
      await this.auditLink(link, 'patient_link.verify_failed', 'failure', { failures });
      if (failures >= this.config.maxFailedAttempts) {
        await this.deps.links.lock(link.id, now);
        await this.auditLink(link, 'patient_link.locked', 'failure', { failures });
        await this.deps.scheduler.notify({
          practiceId: link.practiceId,
          caseId: link.caseId,
          kind: 'patient_link_locked',
        });
        return { status: 'unavailable', reason: 'locked' };
      }
      return {
        status: 'wrong_dob',
        attemptsRemaining: this.config.maxFailedAttempts - failures,
      };
    }

    // Single use: only one caller can exchange the link for a session.
    if (!(await this.deps.links.consume(link.id, now))) {
      await this.auditLink(link, 'patient_link.rejected', 'failure', { reason: 'used' });
      return { status: 'unavailable', reason: 'used' };
    }
    const session = generateToken();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMinutes * 60_000);
    await this.deps.sessions.insert({
      id: session.id,
      practiceId: link.practiceId,
      caseId: link.caseId,
      linkId: link.id,
      secretHash: session.secretHash,
      expiresAt,
    });
    await this.auditLink(link, 'patient_link.verified', 'success', {});
    return { status: 'verified', sessionToken: session.token, expiresAt };
  }

  /**
   * "Request a new link". The answer is always the same to the caller so the form cannot be used
   * to probe links. The new link goes to the contact on file, never to the page.
   * Locked links need a scheduler, so they only notify.
   */
  async requestNewLink(token: string): Promise<{ status: 'accepted' }> {
    const link = await this.resolveLink(token);
    if (!link) return { status: 'accepted' };
    const now = this.deps.clock.now();

    if (link.lockedAt) {
      await this.deps.scheduler.notify({
        practiceId: link.practiceId,
        caseId: link.caseId,
        kind: 'patient_link_reissue_requested',
      });
      await this.auditLink(link, 'patient_link.new_link_requested', 'success', { route: 'scheduler' });
      return { status: 'accepted' };
    }

    const latest = await this.deps.links.latestForCase(link.practiceId, link.caseId);
    const cooldownMs = this.config.newLinkCooldownMinutes * 60_000;
    if (latest && now.getTime() - latest.createdAt.getTime() < cooldownMs) {
      await this.auditLink(link, 'patient_link.new_link_requested', 'failure', { route: 'throttled' });
      return { status: 'accepted' };
    }

    await this.deps.links.consume(link.id, now); // retire the old link
    const issued = await this.issueLink({ practiceId: link.practiceId, caseId: link.caseId });
    await this.deps.delivery.send({
      practiceId: link.practiceId,
      caseId: link.caseId,
      url: issued.url,
      expiresAt: issued.expiresAt,
    });
    await this.auditLink(link, 'patient_link.new_link_requested', 'success', { route: 'sent' });
    return { status: 'accepted' };
  }

  private async resolveSession(sessionToken: string): Promise<PatientSessionRecord | null> {
    const parsed = parseToken(sessionToken);
    if (!parsed) return null;
    const session = await this.deps.sessions.findById(parsed.id);
    if (!session || !secretMatches(parsed.secret, session.secretHash)) return null;
    if (session.expiresAt.getTime() <= this.deps.clock.now().getTime()) return null;
    return session;
  }

  private auditSession(
    session: PatientSessionRecord,
    action: string,
    outcome: 'success' | 'failure',
    detail: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    return this.deps.audit.record({
      practiceId: session.practiceId,
      caseId: session.caseId,
      action,
      outcome,
      at: this.deps.clock.now(),
      actor: { kind: 'patient_link', linkId: session.linkId },
      detail,
    });
  }

  private auditLink(
    link: PatientLinkRecord,
    action: string,
    outcome: 'success' | 'failure',
    detail: Record<string, string | number | boolean>,
  ): Promise<void> {
    return this.deps.audit.record({
      practiceId: link.practiceId,
      caseId: link.caseId,
      action,
      outcome,
      at: this.deps.clock.now(),
      actor: { kind: 'patient_link', linkId: link.id },
      detail,
    });
  }

  /** Fails closed: if the view cannot be audited, nothing is returned. */
  async viewCase(sessionToken: string, options: ViewOptions = {}): Promise<ViewResult> {
    const session = await this.resolveSession(sessionToken);
    if (!session) return { status: 'session_expired' };
    const source = await this.deps.cases.getCase(session.practiceId, session.caseId);
    if (!source) return { status: 'session_expired' };

    const view = toPatientCaseView(source, options.locale ?? source.preferredLocale);
    const contacts = await this.deps.contacts.list(session.practiceId, session.caseId);
    const proposedSlots = options.includeSlots
      ? (await this.deps.slots.propose(session.practiceId, session.caseId)).slice(0, SLOT_LIMIT)
      : null;
    let financial: FinancialLinks | null = null;
    if (source.paymentClass !== 'insured') {
      const links = await this.deps.financial.getLinks(session.practiceId, session.caseId);
      financial = {
        quoteUrl: isHttps(links.quoteUrl) ? links.quoteUrl : null,
        financialConsentUrl: isHttps(links.financialConsentUrl) ? links.financialConsentUrl : null,
        depositUrl: isHttps(links.depositUrl) ? links.depositUrl : null,
      };
    }

    await this.auditSession(session, 'patient_page.viewed', 'success', {
      slotsShown: proposedSlots?.length ?? 0,
    });
    return { status: 'ok', data: { view, contacts, proposedSlots, financial } };
  }

  async saveContactPreferences(
    sessionToken: string,
    contactId: string,
    types: string[],
  ): Promise<ActionResult> {
    const session = await this.resolveSession(sessionToken);
    if (!session) return { status: 'session_expired' };
    const valid = types.filter((t): t is MessageType => (MESSAGE_TYPES as readonly string[]).includes(t));
    if (valid.length !== types.length) return { status: 'rejected' };
    const ok = await this.deps.contacts.setMessageTypes(
      session.practiceId,
      session.caseId,
      contactId,
      [...new Set(valid)],
    );
    await this.auditSession(session, 'patient_page.contact_preferences_changed', ok ? 'success' : 'failure');
    return ok ? { status: 'ok' } : { status: 'rejected' };
  }

  /** Creates a change plan for scheduler approval. Nothing is booked. */
  async chooseSlot(sessionToken: string, slotId: string): Promise<ChooseSlotResult> {
    const session = await this.resolveSession(sessionToken);
    if (!session) return { status: 'session_expired' };
    const offered = (await this.deps.slots.propose(session.practiceId, session.caseId)).slice(0, SLOT_LIMIT);
    const slot = offered.find((s) => s.id === slotId);
    if (!slot) {
      await this.auditSession(session, 'patient_page.reschedule_requested', 'failure');
      return { status: 'rejected' };
    }
    const plan = await this.deps.changePlans.createRescheduleChangePlan({
      practiceId: session.practiceId,
      caseId: session.caseId,
      slot,
      requestedBy: 'patient',
    });
    await this.auditSession(session, 'patient_page.reschedule_requested', 'success', {
      changePlanId: plan.changePlanId,
    });
    return { status: 'requested', changePlanId: plan.changePlanId };
  }
}
