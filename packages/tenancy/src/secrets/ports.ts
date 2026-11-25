/**
 * Ports for per-practice encryption keys and credential vault paths.
 * Real adapters (AWS KMS, AWS Secrets Manager) and in-memory fakes implement these.
 */

/** Opaque practice identifier. The practice is the isolation boundary. */
export type PracticeId = string;

export type KeyStatus = 'absent' | 'active' | 'crypto-shredded';

export interface KeyInfo {
  practiceId: PracticeId;
  keyRef: string;
  status: KeyStatus;
}

export type EncryptionContext = Readonly<Record<string, string>>;

export class KeyDestroyedError extends Error {
  constructor(public readonly practiceId: PracticeId) {
    super(`Practice ${practiceId} is crypto-shredded; key is unavailable`);
    this.name = 'KeyDestroyedError';
  }
}

export class KeyNotFoundError extends Error {
  constructor(public readonly practiceId: PracticeId) {
    super(`No encryption key for practice ${practiceId}`);
    this.name = 'KeyNotFoundError';
  }
}

export interface KeyService {
  /** Create the practice's key at provisioning. Fails if one already exists. */
  createKey(practiceId: PracticeId): Promise<KeyInfo>;
  encrypt(practiceId: PracticeId, plaintext: Uint8Array, context?: EncryptionContext): Promise<Uint8Array>;
  /** Fails closed with KeyDestroyedError after destruction; never returns plaintext then. */
  decrypt(practiceId: PracticeId, ciphertext: Uint8Array, context?: EncryptionContext): Promise<Uint8Array>;
  /** Offboarding: make the key unusable now and destroy it. Marks the practice crypto-shredded. */
  scheduleDestruction(practiceId: PracticeId, pendingWindowDays?: number): Promise<KeyInfo>;
  getStatus(practiceId: PracticeId): Promise<KeyStatus>;
}

export interface SecretStore {
  /** `path` is a vault path built by `secretPath`. */
  get(path: string): Promise<string | undefined>;
  put(path: string, value: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export type SecretAccessEvent = {
  type: 'secret.access.denied' | 'secret.access.granted' | 'secret.access.failed';
  /** Practice on whose behalf the tool call runs. */
  actorPracticeId: PracticeId;
  /** Practice that owns the requested secret. */
  targetPracticeId: PracticeId;
  system: string;
  name: string;
  reason?: string;
  at: Date;
};

/** Audit events never carry secret values. */
export interface AuditSink {
  record(event: SecretAccessEvent): void | Promise<void>;
}
