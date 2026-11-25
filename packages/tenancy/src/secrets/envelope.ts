import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyDestroyedError, type EncryptionContext, type KeyService, type PracticeId } from './ports.js';

/** Serializable envelope for a PHI field or document. Holds no plaintext and no plaintext key. */
export interface SealedEnvelope {
  v: 1;
  practiceId: PracticeId;
  /** Data key wrapped by the practice's key (base64). */
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

function contextFor(practiceId: PracticeId, context?: EncryptionContext): EncryptionContext {
  return { ...context, practiceId };
}

function aadFor(practiceId: PracticeId, context?: EncryptionContext): Buffer {
  const entries = Object.entries(contextFor(practiceId, context)).sort(([a], [b]) => a.localeCompare(b));
  return Buffer.from(JSON.stringify(entries));
}

/**
 * Envelope encryption: a fresh AES-256-GCM data key per item, wrapped by the practice's key.
 * After the practice key is destroyed, every open() fails closed.
 */
export class EnvelopeEncryptor {
  constructor(private readonly keys: KeyService) {}

  async seal(
    practiceId: PracticeId,
    plaintext: Uint8Array | string,
    context?: EncryptionContext,
  ): Promise<SealedEnvelope> {
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
    const dek = randomBytes(32);
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dek, iv);
      cipher.setAAD(aadFor(practiceId, context));
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
      const wrapped = await this.keys.encrypt(practiceId, dek, contextFor(practiceId, context));
      return {
        v: 1,
        practiceId,
        wrappedKey: Buffer.from(wrapped).toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } finally {
      dek.fill(0);
    }
  }

  async open(
    practiceId: PracticeId,
    envelope: SealedEnvelope,
    context?: EncryptionContext,
  ): Promise<Uint8Array> {
    if (envelope.v !== 1) throw new EnvelopeError('Unsupported envelope version');
    if (envelope.practiceId !== practiceId) throw new EnvelopeError('Envelope belongs to another practice');
    if ((await this.keys.getStatus(practiceId)) === 'crypto-shredded') throw new KeyDestroyedError(practiceId);
    const dek = Buffer.from(
      await this.keys.decrypt(practiceId, Buffer.from(envelope.wrappedKey, 'base64'), contextFor(practiceId, context)),
    );
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(aadFor(practiceId, context));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const out = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      return new Uint8Array(out);
    } finally {
      dek.fill(0);
    }
  }

  async openText(practiceId: PracticeId, envelope: SealedEnvelope, context?: EncryptionContext): Promise<string> {
    return Buffer.from(await this.open(practiceId, envelope, context)).toString('utf8');
  }
}
