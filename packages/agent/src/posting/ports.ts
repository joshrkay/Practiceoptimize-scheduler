import type {
  DeliveryChannel,
  FacilityDirectoryEntry,
  Mismatch,
  PostingDocument,
  PracticeId,
  Submission,
} from './types.js';

/** Port: facility directory (other branch). */
export interface FacilityDirectory {
  get(practiceId: PracticeId, facilityId: string): Promise<FacilityDirectoryEntry | undefined>;
}

/** Port: the send tool (other branch). Email, fax or a portal task for a person. */
export interface SendTool {
  send(request: {
    practiceId: PracticeId;
    caseId: string;
    channel: DeliveryChannel;
    document: PostingDocument;
  }): Promise<{ messageId: string }>;
}

/** Port: direct scheduling-system route (RAH-77). Not built here. */
export interface DirectSchedulingRoute {
  submit(request: {
    practiceId: PracticeId;
    caseId: string;
    systemId: string;
    document: PostingDocument;
  }): Promise<{ accepted: boolean; reference?: string }>;
}

/** Port: policy engine (RAH-17). Posting is approve-first. */
export interface PostingPolicy {
  evaluate(request: {
    practiceId: PracticeId;
    caseId: string;
    action: 'facility_posting';
  }): Promise<{ decision: 'approve_first' | 'deny' }>;
}

export interface ReviewItem {
  practiceId: PracticeId;
  caseId: string;
  submissionId: string;
  summary: string;
}

/** Port: review queue (other branch). */
export interface ReviewQueue {
  enqueueForApproval(item: ReviewItem): Promise<void>;
  escalate(item: ReviewItem & { reason: string; mismatches: Mismatch[] }): Promise<void>;
}

/** Port: clock. */
export interface Clock {
  now(): Date;
}

/** Port: persistence of submissions. Every call is scoped by practice. */
export interface SubmissionStore {
  save(submission: Submission): Promise<void>;
  get(practiceId: PracticeId, id: string): Promise<Submission | undefined>;
  listByCase(practiceId: PracticeId, caseId: string): Promise<Submission[]>;
  listByPractice(practiceId: PracticeId): Promise<Submission[]>;
}

/**
 * Shape of a confirmation the inbound matcher (RAH-37) hands over; the matcher
 * calls PostingService.recordConfirmation with these fields.
 */
export interface InboundConfirmation {
  practiceId: PracticeId;
  caseId: string;
  confirmationNumber: string;
}
