import type { HardRuleResult, PracticeId } from './ports';

export type ReviewStatus =
  | 'pending'
  | 'executing'
  | 'approved'
  | 'edited_approved'
  | 'rejected'
  | 'expired'
  | 'failed';

export interface PolicyResult {
  readonly tier: string;
  readonly humanOnly: boolean;
  readonly summary: string;
}

export interface DiffEntry {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ReviewItem {
  readonly id: string;
  readonly practiceId: PracticeId;
  readonly caseId: string;
  readonly actionType: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  /** One-line reason the agent proposed this. */
  readonly reason: string;
  readonly evidenceLinks: readonly string[];
  readonly policyResult: PolicyResult;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: ReviewStatus;
  readonly decidedBy?: string;
  readonly decidedAt?: Date;
  readonly rejectionReason?: string;
  readonly diff?: readonly DiffEntry[];
  readonly executedInputs?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface NewReviewItem {
  readonly caseId: string;
  readonly actionType: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly evidenceLinks: readonly string[];
  readonly policyResult: PolicyResult;
  /** Override the configured expiry for this item. */
  readonly expiresAt?: Date;
}

/** Labeled feedback for the evaluation harness. */
export interface FeedbackRecord {
  readonly practiceId: PracticeId;
  readonly itemId: string;
  readonly caseId: string;
  readonly actionType: string;
  readonly label: 'edited' | 'rejected';
  readonly originalInputs: Readonly<Record<string, unknown>>;
  readonly editedInputs?: Readonly<Record<string, unknown>>;
  readonly diff?: readonly DiffEntry[];
  readonly reason?: string;
  readonly actorId: string;
  readonly createdAt: Date;
}

export interface Takeover {
  readonly practiceId: PracticeId;
  readonly caseId: string;
  readonly userId: string;
  readonly since: Date;
}

/** The authenticated actor. The practice always comes from the session, never a request body. */
export interface Actor {
  readonly practiceId: PracticeId;
  readonly userId: string;
}

export type DecisionFailure = {
  readonly ok: false;
  readonly code: 'not_found' | 'not_pending' | 'expired' | 'hard_rule_failed' | 'execution_failed' | 'invalid';
  readonly message: string;
  readonly item?: ReviewItem;
  readonly hardRule?: HardRuleResult;
};

export type DecisionResult = { readonly ok: true; readonly item: ReviewItem } | DecisionFailure;

export interface BulkApproveResult {
  readonly approved: readonly ReviewItem[];
  readonly dropped: readonly { readonly itemId: string; readonly code: string; readonly reason: string }[];
}
