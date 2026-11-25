import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { SecretStore } from './ports.js';

export interface SecretsManagerStoreOptions {
  /** Injected client; tests pass a stub, production passes a configured SecretsManagerClient. */
  client: Pick<SecretsManagerClient, 'send'>;
  /** Optional per-practice KMS key resolver so secrets are encrypted under the practice's key. */
  kmsKeyIdFor?: (path: string) => string | undefined;
  /** Recovery window on delete, in days (7-30). Default 7. */
  recoveryWindowDays?: number;
}

function errName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
}

/** SecretStore backed by AWS Secrets Manager; the secret id is the vault path. */
export class SecretsManagerStore implements SecretStore {
  constructor(private readonly opts: SecretsManagerStoreOptions) {}

  async get(path: string): Promise<string | undefined> {
    try {
      const out = await this.opts.client.send(new GetSecretValueCommand({ SecretId: path }));
      return out.SecretString;
    } catch (e) {
      if (errName(e) === 'ResourceNotFoundException') return undefined;
      // eslint-disable-next-line preserve-caught-error -- SDK error deliberately not chained to avoid leaking request details
      throw new Error(`Secret read failed (${errName(e) || 'error'})`);
    }
  }

  async put(path: string, value: string): Promise<void> {
    try {
      await this.opts.client.send(new PutSecretValueCommand({ SecretId: path, SecretString: value }));
    } catch (e) {
      // eslint-disable-next-line preserve-caught-error -- SDK error deliberately not chained to avoid leaking request details
      if (errName(e) !== 'ResourceNotFoundException') throw new Error(`Secret write failed (${errName(e) || 'error'})`);
      const kms = this.opts.kmsKeyIdFor?.(path);
      await this.opts.client.send(
        new CreateSecretCommand({ Name: path, SecretString: value, ...(kms ? { KmsKeyId: kms } : {}) }),
      );
    }
  }

  async delete(path: string): Promise<void> {
    try {
      await this.opts.client.send(
        new DeleteSecretCommand({ SecretId: path, RecoveryWindowInDays: this.opts.recoveryWindowDays ?? 7 }),
      );
    } catch (e) {
      // eslint-disable-next-line preserve-caught-error -- SDK error deliberately not chained to avoid leaking request details
      if (errName(e) !== 'ResourceNotFoundException') throw new Error(`Secret delete failed (${errName(e) || 'error'})`);
    }
  }
}
