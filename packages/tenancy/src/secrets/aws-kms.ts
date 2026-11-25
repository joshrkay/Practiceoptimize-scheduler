import {
  CreateAliasCommand,
  CreateKeyCommand,
  DecryptCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  EncryptCommand,
  ScheduleKeyDeletionCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';
import {
  KeyDestroyedError,
  KeyNotFoundError,
  type EncryptionContext,
  type KeyInfo,
  type KeyService,
  type KeyStatus,
  type PracticeId,
} from './ports.js';

export interface KmsKeyServiceOptions {
  /** Injected client; tests pass a stub, production passes a configured KMSClient. */
  client: Pick<KMSClient, 'send'>;
  /** Alias prefix. Default `alias/practice/`. */
  aliasPrefix?: string;
}

function errName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
}

/** KeyService backed by one AWS KMS key per practice, addressed by alias. Not exercised against AWS here. */
export class KmsKeyService implements KeyService {
  private readonly client: Pick<KMSClient, 'send'>;
  private readonly prefix: string;

  constructor(opts: KmsKeyServiceOptions) {
    this.client = opts.client;
    this.prefix = opts.aliasPrefix ?? 'alias/practice/';
  }

  private alias(practiceId: PracticeId): string {
    return `${this.prefix}${practiceId}`;
  }

  async createKey(practiceId: PracticeId): Promise<KeyInfo> {
    const created = await this.client.send(
      new CreateKeyCommand({
        Description: `Practice ${practiceId} data key`,
        KeyUsage: 'ENCRYPT_DECRYPT',
        KeySpec: 'SYMMETRIC_DEFAULT',
        Tags: [{ TagKey: 'practice_id', TagValue: practiceId }],
      }),
    );
    const keyId = created.KeyMetadata?.KeyId;
    if (!keyId) throw new Error('KMS did not return a key id');
    await this.client.send(new CreateAliasCommand({ AliasName: this.alias(practiceId), TargetKeyId: keyId }));
    return { practiceId, keyRef: keyId, status: 'active' };
  }

  async encrypt(practiceId: PracticeId, plaintext: Uint8Array, context?: EncryptionContext): Promise<Uint8Array> {
    try {
      const out = await this.client.send(
        new EncryptCommand({
          KeyId: this.alias(practiceId),
          Plaintext: plaintext,
          EncryptionContext: { ...context, practiceId },
        }),
      );
      if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext');
      return out.CiphertextBlob;
    } catch (e) {
      throw this.translate(practiceId, e);
    }
  }

  async decrypt(practiceId: PracticeId, ciphertext: Uint8Array, context?: EncryptionContext): Promise<Uint8Array> {
    try {
      const out = await this.client.send(
        new DecryptCommand({
          KeyId: this.alias(practiceId),
          CiphertextBlob: ciphertext,
          EncryptionContext: { ...context, practiceId },
        }),
      );
      if (!out.Plaintext) throw new Error('KMS returned no plaintext');
      return out.Plaintext;
    } catch (e) {
      throw this.translate(practiceId, e);
    }
  }

  /** Disables the key immediately (reads fail at once), then schedules deletion (7-30 day window). */
  async scheduleDestruction(practiceId: PracticeId, pendingWindowDays = 7): Promise<KeyInfo> {
    const keyId = this.alias(practiceId);
    try {
      await this.client.send(new DisableKeyCommand({ KeyId: keyId }));
      await this.client.send(
        new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: pendingWindowDays }),
      );
    } catch (e) {
      throw this.translate(practiceId, e);
    }
    return { practiceId, keyRef: keyId, status: 'crypto-shredded' };
  }

  async getStatus(practiceId: PracticeId): Promise<KeyStatus> {
    try {
      const out = await this.client.send(new DescribeKeyCommand({ KeyId: this.alias(practiceId) }));
      const meta = out.KeyMetadata;
      if (!meta) return 'absent';
      if (meta.KeyState === 'PendingDeletion' || meta.KeyState === 'Disabled' || meta.KeyState === 'Unavailable') {
        return 'crypto-shredded';
      }
      return 'active';
    } catch (e) {
      if (errName(e) === 'NotFoundException') return 'absent';
      throw e;
    }
  }

  private translate(practiceId: PracticeId, e: unknown): Error {
    switch (errName(e)) {
      case 'KMSInvalidStateException':
      case 'DisabledException':
      case 'KeyUnavailableException':
        return new KeyDestroyedError(practiceId);
      case 'NotFoundException':
        return new KeyNotFoundError(practiceId);
      default:
        return e instanceof Error ? e : new Error('KMS error');
    }
  }
}
