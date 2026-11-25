import { describe, expect, it } from 'vitest';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { KeyDestroyedError, KeyNotFoundError, KmsKeyService, SecretsManagerStore } from './index.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function stub(handler: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    send: (cmd: Cmd) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      try {
        return Promise.resolve(handler(cmd.constructor.name, cmd.input));
      } catch (e) {
        return Promise.reject(e as Error);
      }
    },
  };
  return { calls, client };
}

const awsErr = (name: string) => Object.assign(new Error(name), { name });

describe('KmsKeyService', () => {
  it('creates a key with alias and practice tag', async () => {
    const { calls, client } = stub((n) => (n === 'CreateKeyCommand' ? { KeyMetadata: { KeyId: 'k-1' } } : {}));
    const svc = new KmsKeyService({ client: client as unknown as KMSClient });
    const info = await svc.createKey('p1');
    expect(info).toEqual({ practiceId: 'p1', keyRef: 'k-1', status: 'active' });
    expect(calls[0]?.input).toMatchObject({ Tags: [{ TagKey: 'practice_id', TagValue: 'p1' }] });
    expect(calls[1]?.input).toEqual({ AliasName: 'alias/practice/p1', TargetKeyId: 'k-1' });
  });

  it('fails when KMS returns no key id', async () => {
    const { client } = stub(() => ({}));
    await expect(new KmsKeyService({ client: client as unknown as KMSClient }).createKey('p1')).rejects.toThrow('key id');
  });

  it('encrypts and decrypts with practice-bound context', async () => {
    const { calls, client } = stub((n) =>
      n === 'EncryptCommand' ? { CiphertextBlob: new Uint8Array([9]) } : { Plaintext: new Uint8Array([1]) },
    );
    const svc = new KmsKeyService({ client: client as unknown as KMSClient, aliasPrefix: 'alias/x/' });
    expect(await svc.encrypt('p1', new Uint8Array([1]), { f: 'a' })).toEqual(new Uint8Array([9]));
    expect(await svc.decrypt('p1', new Uint8Array([9]))).toEqual(new Uint8Array([1]));
    expect(calls[0]?.input).toMatchObject({ KeyId: 'alias/x/p1', EncryptionContext: { f: 'a', practiceId: 'p1' } });
    expect(calls[1]?.input).toMatchObject({ EncryptionContext: { practiceId: 'p1' } });
  });

  it('errors on empty KMS responses', async () => {
    const { client } = stub(() => ({}));
    const svc = new KmsKeyService({ client: client as unknown as KMSClient });
    await expect(svc.encrypt('p1', new Uint8Array([1]))).rejects.toThrow('ciphertext');
    await expect(svc.decrypt('p1', new Uint8Array([1]))).rejects.toThrow('plaintext');
  });

  it('maps disabled/pending-deletion and missing keys to fail-closed errors', async () => {
    for (const n of ['KMSInvalidStateException', 'DisabledException', 'KeyUnavailableException']) {
      const { client } = stub(() => {
        throw awsErr(n);
      });
      const svc = new KmsKeyService({ client: client as unknown as KMSClient });
      await expect(svc.decrypt('p1', new Uint8Array([1]))).rejects.toBeInstanceOf(KeyDestroyedError);
    }
    const nf = stub(() => {
      throw awsErr('NotFoundException');
    });
    const svc = new KmsKeyService({ client: nf.client as unknown as KMSClient });
    await expect(svc.encrypt('p1', new Uint8Array([1]))).rejects.toBeInstanceOf(KeyNotFoundError);
    const other = stub(() => {
      throw new Error('boom');
    });
    await expect(
      new KmsKeyService({ client: other.client as unknown as KMSClient }).encrypt('p1', new Uint8Array([1])),
    ).rejects.toThrow('boom');
    const nonError = stub(() => {
      throw 'str';
    });
    await expect(
      new KmsKeyService({ client: nonError.client as unknown as KMSClient }).encrypt('p1', new Uint8Array([1])),
    ).rejects.toThrow('KMS error');
  });

  it('disables then schedules deletion', async () => {
    const { calls, client } = stub(() => ({}));
    const svc = new KmsKeyService({ client: client as unknown as KMSClient });
    const info = await svc.scheduleDestruction('p1', 30);
    expect(info.status).toBe('crypto-shredded');
    expect(calls.map((c) => c.name)).toEqual(['DisableKeyCommand', 'ScheduleKeyDeletionCommand']);
    expect(calls[1]?.input).toMatchObject({ PendingWindowInDays: 30 });
    await svc.scheduleDestruction('p1');
    expect(calls[3]?.input).toMatchObject({ PendingWindowInDays: 7 });
  });

  it('propagates translated errors from destruction', async () => {
    const { client } = stub(() => {
      throw awsErr('NotFoundException');
    });
    await expect(
      new KmsKeyService({ client: client as unknown as KMSClient }).scheduleDestruction('p1'),
    ).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it('derives status from key state', async () => {
    const states: Array<[unknown, string]> = [
      [{ KeyMetadata: { KeyState: 'Enabled' } }, 'active'],
      [{ KeyMetadata: { KeyState: 'PendingDeletion' } }, 'crypto-shredded'],
      [{ KeyMetadata: { KeyState: 'Disabled' } }, 'crypto-shredded'],
      [{}, 'absent'],
    ];
    for (const [resp, want] of states) {
      const { client } = stub(() => resp);
      expect(await new KmsKeyService({ client: client as unknown as KMSClient }).getStatus('p1')).toBe(want);
    }
    const nf = stub(() => {
      throw awsErr('NotFoundException');
    });
    expect(await new KmsKeyService({ client: nf.client as unknown as KMSClient }).getStatus('p1')).toBe('absent');
    const bad = stub(() => {
      throw awsErr('AccessDeniedException');
    });
    await expect(new KmsKeyService({ client: bad.client as unknown as KMSClient }).getStatus('p1')).rejects.toThrow();
  });
});

describe('SecretsManagerStore', () => {
  const as = (c: unknown) => c as SecretsManagerClient;

  it('gets by vault path, undefined when missing', async () => {
    const ok = stub(() => ({ SecretString: 'v' }));
    expect(await new SecretsManagerStore({ client: as(ok.client) }).get('practices/p/a/b')).toBe('v');
    expect(ok.calls[0]?.input).toEqual({ SecretId: 'practices/p/a/b' });
    const nf = stub(() => {
      throw awsErr('ResourceNotFoundException');
    });
    expect(await new SecretsManagerStore({ client: as(nf.client) }).get('x')).toBeUndefined();
  });

  it('does not leak SDK error text on read failure', async () => {
    const bad = stub(() => {
      throw Object.assign(new Error('contains secret-value'), { name: 'ThrottlingException' });
    });
    await expect(new SecretsManagerStore({ client: as(bad.client) }).get('x')).rejects.toThrow(
      'Secret read failed (ThrottlingException)',
    );
    const anon = stub(() => {
      throw 1;
    });
    await expect(new SecretsManagerStore({ client: as(anon.client) }).get('x')).rejects.toThrow('(error)');
  });

  it('puts, creating with the practice key when missing', async () => {
    const put = stub(() => ({}));
    await new SecretsManagerStore({ client: as(put.client) }).put('p', 'v');
    expect(put.calls.map((c) => c.name)).toEqual(['PutSecretValueCommand']);

    const create = stub((n) => {
      if (n === 'PutSecretValueCommand') throw awsErr('ResourceNotFoundException');
      return {};
    });
    await new SecretsManagerStore({ client: as(create.client), kmsKeyIdFor: () => 'alias/practice/p' }).put('p', 'v');
    expect(create.calls[1]).toMatchObject({ name: 'CreateSecretCommand', input: { KmsKeyId: 'alias/practice/p' } });

    const create2 = stub((n) => {
      if (n === 'PutSecretValueCommand') throw awsErr('ResourceNotFoundException');
      return {};
    });
    await new SecretsManagerStore({ client: as(create2.client) }).put('p', 'v');
    expect(create2.calls[1]?.input).not.toHaveProperty('KmsKeyId');

    const bad = stub(() => {
      throw awsErr('InternalServiceError');
    });
    await expect(new SecretsManagerStore({ client: as(bad.client) }).put('p', 'v')).rejects.toThrow('write failed');
    const anon = stub(() => {
      throw 1;
    });
    await expect(new SecretsManagerStore({ client: as(anon.client) }).put('p', 'v')).rejects.toThrow('(error)');
  });

  it('deletes with a recovery window and tolerates missing', async () => {
    const del = stub(() => ({}));
    await new SecretsManagerStore({ client: as(del.client), recoveryWindowDays: 14 }).delete('p');
    expect(del.calls[0]?.input).toEqual({ SecretId: 'p', RecoveryWindowInDays: 14 });
    await new SecretsManagerStore({ client: as(del.client) }).delete('p');
    expect(del.calls[1]?.input).toMatchObject({ RecoveryWindowInDays: 7 });
    const nf = stub(() => {
      throw awsErr('ResourceNotFoundException');
    });
    await new SecretsManagerStore({ client: as(nf.client) }).delete('p');
    const bad = stub(() => {
      throw awsErr('X');
    });
    await expect(new SecretsManagerStore({ client: as(bad.client) }).delete('p')).rejects.toThrow('delete failed');
    const anon = stub(() => {
      throw 1;
    });
    await expect(new SecretsManagerStore({ client: as(anon.client) }).delete('p')).rejects.toThrow('(error)');
  });
});
