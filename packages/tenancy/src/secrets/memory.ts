import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  KeyDestroyedError,
  KeyNotFoundError,
  type EncryptionContext,
  type KeyInfo,
  type KeyService,
  type KeyStatus,
  type PracticeId,
  type SecretStore,
} from './ports.js';

const IV = 12;
const TAG = 16;

function aad(practiceId: PracticeId, context?: EncryptionContext): Buffer {
  const entries = Object.entries({ ...context, practiceId }).sort(([a], [b]) => a.localeCompare(b));
  return Buffer.from(JSON.stringify(entries));
}

/** In-memory KeyService for tests: AES-256-GCM master key per practice. */
export class InMemoryKeyService implements KeyService {
  private readonly keys = new Map<PracticeId, Buffer>();
  private readonly shredded = new Set<PracticeId>();

  createKey(practiceId: PracticeId): Promise<KeyInfo> {
    if (this.keys.has(practiceId) || this.shredded.has(practiceId)) {
      return Promise.reject(new Error(`Key already exists for practice ${practiceId}`));
    }
    this.keys.set(practiceId, randomBytes(32));
    return Promise.resolve(this.info(practiceId));
  }

  async encrypt(practiceId: PracticeId, plaintext: Uint8Array, context?: EncryptionContext): Promise<Uint8Array> {
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', this.key(practiceId), iv);
    cipher.setAAD(aad(practiceId, context));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Promise.resolve(new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body])));
  }

  async decrypt(practiceId: PracticeId, ciphertext: Uint8Array, context?: EncryptionContext): Promise<Uint8Array> {
    const buf = Buffer.from(ciphertext);
    const decipher = createDecipheriv('aes-256-gcm', this.key(practiceId), buf.subarray(0, IV));
    decipher.setAAD(aad(practiceId, context));
    decipher.setAuthTag(buf.subarray(IV, IV + TAG));
    const out = Buffer.concat([decipher.update(buf.subarray(IV + TAG)), decipher.final()]);
    return Promise.resolve(new Uint8Array(out));
  }

  scheduleDestruction(practiceId: PracticeId): Promise<KeyInfo> {
    const key = this.keys.get(practiceId);
    if (!key && !this.shredded.has(practiceId)) return Promise.reject(new KeyNotFoundError(practiceId));
    key?.fill(0);
    this.keys.delete(practiceId);
    this.shredded.add(practiceId);
    return Promise.resolve(this.info(practiceId));
  }

  getStatus(practiceId: PracticeId): Promise<KeyStatus> {
    return Promise.resolve(this.statusOf(practiceId));
  }

  private statusOf(practiceId: PracticeId): KeyStatus {
    if (this.shredded.has(practiceId)) return 'crypto-shredded';
    return this.keys.has(practiceId) ? 'active' : 'absent';
  }

  private info(practiceId: PracticeId): KeyInfo {
    return { practiceId, keyRef: `memory:${practiceId}`, status: this.statusOf(practiceId) };
  }

  private key(practiceId: PracticeId): Buffer {
    if (this.shredded.has(practiceId)) throw new KeyDestroyedError(practiceId);
    const key = this.keys.get(practiceId);
    if (!key) throw new KeyNotFoundError(practiceId);
    return key;
  }
}

/** In-memory SecretStore for tests. */
export class InMemorySecretStore implements SecretStore {
  private readonly data = new Map<string, string>();

  get(path: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(path));
  }

  put(path: string, value: string): Promise<void> {
    this.data.set(path, value);
    return Promise.resolve();
  }

  delete(path: string): Promise<void> {
    this.data.delete(path);
    return Promise.resolve();
  }

  /** Test helper: stored paths, never values. */
  paths(): string[] {
    return [...this.data.keys()];
  }
}
