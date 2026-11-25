import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { secretPath } from './paths.js';
import {
  KeyDestroyedError,
  type AuditSink,
  type KeyService,
  type PracticeId,
  type SecretAccessEvent,
  type SecretStore,
} from './ports.js';

export class SecretAccessDeniedError extends Error {
  constructor(message = 'Secret access denied') {
    super(message);
    this.name = 'SecretAccessDeniedError';
  }
}

export class SecretNotFoundError extends Error {
  constructor() {
    super('Secret not found');
    this.name = 'SecretNotFoundError';
  }
}

export class CredentialHandleExpiredError extends Error {
  constructor() {
    super('Credential handle expired');
    this.name = 'CredentialHandleExpiredError';
  }
}

interface HandleRecord {
  secret: string;
  expiresAt: number;
  now: () => number;
}

// Secret material lives only here, keyed by the handle object. It is unreachable from
// the handle's own properties, so serialization and inspection cannot expose it.
const records = new WeakMap<object, HandleRecord>();

/** Short-lived opaque reference to a credential. Pass it to tool implementations only. */
export class CredentialHandle {
  readonly id = randomUUID();
  readonly expiresAt: Date;

  constructor(secret: string, expiresAt: number, now: () => number) {
    this.expiresAt = new Date(expiresAt);
    records.set(this, { secret, expiresAt, now });
  }

  toJSON(): string {
    return '[CredentialHandle]';
  }

  toString(): string {
    return '[CredentialHandle]';
  }

  [inspect.custom](): string {
    return '[CredentialHandle]';
  }
}

/**
 * Run `fn` with the secret. Intended for tool implementations (HTTP clients, portal automation);
 * the model layer and loggers only ever see the handle. Throws once the handle has expired.
 */
export async function withCredential<T>(handle: CredentialHandle, fn: (secret: string) => Promise<T> | T): Promise<T> {
  const rec = records.get(handle);
  if (!rec || rec.now() >= rec.expiresAt) {
    records.delete(handle);
    throw new CredentialHandleExpiredError();
  }
  return fn(rec.secret);
}

export interface CredentialBrokerOptions {
  secrets: SecretStore;
  keys: KeyService;
  audit: AuditSink;
  /** Handle lifetime. Default 60 seconds. */
  ttlMs?: number;
  now?: () => number;
}

export interface CredentialRequest {
  /** Practice on whose behalf the tool call runs (from the authenticated context). */
  actorPracticeId: PracticeId;
  /** Practice that owns the credential. */
  practiceId: PracticeId;
  system: string;
  name: string;
}

export class CredentialBroker {
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: CredentialBrokerOptions) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  async request(req: CredentialRequest): Promise<CredentialHandle> {
    const path = secretPath(req.practiceId, req.system, req.name);
    if (req.actorPracticeId !== req.practiceId) {
      await this.audit(req, 'secret.access.denied', 'cross-practice request');
      throw new SecretAccessDeniedError();
    }
    if ((await this.opts.keys.getStatus(req.practiceId)) === 'crypto-shredded') {
      await this.audit(req, 'secret.access.failed', 'practice crypto-shredded');
      throw new KeyDestroyedError(req.practiceId);
    }
    const secret = await this.opts.secrets.get(path);
    if (secret === undefined) {
      await this.audit(req, 'secret.access.failed', 'not found');
      throw new SecretNotFoundError();
    }
    await this.audit(req, 'secret.access.granted');
    return new CredentialHandle(secret, this.now() + this.ttlMs, this.now);
  }

  private async audit(req: CredentialRequest, type: SecretAccessEvent['type'], reason?: string): Promise<void> {
    await this.opts.audit.record({
      type,
      actorPracticeId: req.actorPracticeId,
      targetPracticeId: req.practiceId,
      system: req.system,
      name: req.name,
      ...(reason ? { reason } : {}),
      at: new Date(this.now()),
    });
  }
}
