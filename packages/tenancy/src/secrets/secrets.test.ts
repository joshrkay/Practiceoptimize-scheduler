import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CredentialBroker,
  CredentialHandleExpiredError,
  EnvelopeEncryptor,
  InMemoryKeyService,
  InMemorySecretStore,
  KeyDestroyedError,
  KeyNotFoundError,
  SecretAccessDeniedError,
  SecretNotFoundError,
  secretPath,
  withCredential,
  type SecretAccessEvent,
} from './index.js';

const A = 'practice-a';
const B = 'practice-b';
const TOKEN_B = 'synthetic-availity-token-B-0001';
const TOKEN_A = 'synthetic-availity-token-A-0001';

async function setup(now = () => 1_000) {
  const keys = new InMemoryKeyService();
  const secrets = new InMemorySecretStore();
  const events: SecretAccessEvent[] = [];
  await keys.createKey(A);
  await keys.createKey(B);
  await secrets.put(secretPath(A, 'availity', 'token'), TOKEN_A);
  await secrets.put(secretPath(B, 'availity', 'token'), TOKEN_B);
  const broker = new CredentialBroker({
    secrets,
    keys,
    audit: { record: (e) => void events.push(e) },
    ttlMs: 1000,
    now,
  });
  return { keys, secrets, events, broker, envelope: new EnvelopeEncryptor(keys) };
}

describe('secretPath', () => {
  it('builds practices/{practice_id}/{system}/{name}', () => {
    expect(secretPath(A, 'availity', 'token')).toBe('practices/practice-a/availity/token');
  });
  it('rejects traversal and separators', () => {
    expect(() => secretPath('../x', 's', 'n')).toThrow();
    expect(() => secretPath(A, 'a/b', 'n')).toThrow();
    expect(() => secretPath(A, 's', 'a..b')).toThrow();
    expect(() => secretPath(A, 's', '')).toThrow();
  });
});

describe('isolated secrets', () => {
  it('denies and audits practice A requesting practice B token', async () => {
    const { broker, events } = await setup();
    await expect(
      broker.request({ actorPracticeId: A, practiceId: B, system: 'availity', name: 'token' }),
    ).rejects.toBeInstanceOf(SecretAccessDeniedError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'secret.access.denied',
      actorPracticeId: A,
      targetPracticeId: B,
      system: 'availity',
      name: 'token',
    });
    expect(JSON.stringify(events)).not.toContain(TOKEN_B);
  });

  it('grants own secret via handle and audits it', async () => {
    const { broker, events } = await setup();
    const h = await broker.request({ actorPracticeId: A, practiceId: A, system: 'availity', name: 'token' });
    expect(await withCredential(h, (s) => s)).toBe(TOKEN_A);
    expect(events.map((e) => e.type)).toEqual(['secret.access.granted']);
    expect(JSON.stringify(events)).not.toContain(TOKEN_A);
  });

  it('reports missing secrets', async () => {
    const { broker, events } = await setup();
    await expect(
      broker.request({ actorPracticeId: A, practiceId: A, system: 'availity', name: 'nope' }),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(events[0]?.type).toBe('secret.access.failed');
  });

  it('fails closed for a crypto-shredded practice', async () => {
    const { broker, keys, events } = await setup();
    await keys.scheduleDestruction(A);
    await expect(
      broker.request({ actorPracticeId: A, practiceId: A, system: 'availity', name: 'token' }),
    ).rejects.toBeInstanceOf(KeyDestroyedError);
    expect(events[0]).toMatchObject({ type: 'secret.access.failed', reason: 'practice crypto-shredded' });
  });
});

describe('credential handles', () => {
  it('never serializes or inspects the secret', async () => {
    const { broker } = await setup();
    const h = await broker.request({ actorPracticeId: A, practiceId: A, system: 'availity', name: 'token' });
    expect(JSON.stringify(h)).not.toContain(TOKEN_A);
    expect(JSON.stringify({ wrapped: h })).not.toContain(TOKEN_A);
    expect(inspect(h, { depth: 5, showHidden: true })).not.toContain(TOKEN_A);
    expect(String(h)).not.toContain(TOKEN_A);
    expect(`${JSON.stringify(h)}${inspect(h)}`).toContain('CredentialHandle');
    expect(Object.values(h).join(',')).not.toContain(TOKEN_A);
  });

  it('expires after ttl', async () => {
    let t = 1_000;
    const { broker } = await setup(() => t);
    const h = await broker.request({ actorPracticeId: A, practiceId: A, system: 'availity', name: 'token' });
    expect(h.expiresAt.getTime()).toBe(2_000);
    t = 2_000;
    await expect(withCredential(h, (s) => s)).rejects.toBeInstanceOf(CredentialHandleExpiredError);
    // stays expired even if the clock moves back
    t = 1_500;
    await expect(withCredential(h, (s) => s)).rejects.toBeInstanceOf(CredentialHandleExpiredError);
  });

  it('uses default ttl and clock', async () => {
    const broker = new CredentialBroker({
      secrets: new InMemorySecretStore(),
      keys: new InMemoryKeyService(),
      audit: { record: () => undefined },
    });
    await expect(
      broker.request({ actorPracticeId: A, practiceId: A, system: 's', name: 'n' }),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe('envelope encryption and crypto-shredding', () => {
  it('round-trips fields and documents', async () => {
    const { envelope } = await setup();
    const env = await envelope.seal(A, 'Synthetic Patient, DOB 2000-01-01', { field: 'name' });
    expect(JSON.stringify(env)).not.toContain('Synthetic Patient');
    expect(await envelope.openText(A, env, { field: 'name' })).toBe('Synthetic Patient, DOB 2000-01-01');
    const doc = new Uint8Array([1, 2, 3, 250]);
    expect([...(await envelope.open(A, await envelope.seal(A, doc)))]).toEqual([1, 2, 3, 250]);
  });

  it('rejects wrong practice, wrong context, tampering, bad version', async () => {
    const { envelope } = await setup();
    const env = await envelope.seal(A, 'x', { field: 'name' });
    await expect(envelope.open(B, env)).rejects.toThrow('another practice');
    await expect(envelope.open(A, env, { field: 'other' })).rejects.toThrow();
    await expect(envelope.open(A, env)).rejects.toThrow();
    await expect(envelope.open(A, { ...env, ciphertext: Buffer.from('zz').toString('base64') }, { field: 'name' })).rejects.toThrow();
    await expect(envelope.open(A, { ...env, v: 2 as 1 })).rejects.toThrow('version');
    // B's key cannot unwrap A's data key even if the practice id is forged
    await expect(envelope.open(B, { ...env, practiceId: B }, { field: 'name' })).rejects.toThrow();
  });

  it('after destruction decryption fails and no plaintext is returned', async () => {
    const { envelope, keys } = await setup();
    const env = await envelope.seal(A, 'PHI note');
    const other = await envelope.seal(B, 'other practice note');
    const info = await keys.scheduleDestruction(A);
    expect(info.status).toBe('crypto-shredded');
    expect(await keys.getStatus(A)).toBe('crypto-shredded');
    let leaked: unknown;
    await expect(envelope.open(A, env).then((v) => (leaked = v))).rejects.toBeInstanceOf(KeyDestroyedError);
    expect(leaked).toBeUndefined();
    await expect(envelope.seal(A, 'new')).rejects.toBeInstanceOf(KeyDestroyedError);
    // other practices unaffected
    expect(await envelope.openText(B, other)).toBe('other practice note');
  });
});

describe('InMemoryKeyService', () => {
  it('lifecycle edge cases', async () => {
    const keys = new InMemoryKeyService();
    expect(await keys.getStatus(A)).toBe('absent');
    await expect(keys.encrypt(A, new Uint8Array([1]))).rejects.toBeInstanceOf(KeyNotFoundError);
    await expect(keys.scheduleDestruction(A)).rejects.toBeInstanceOf(KeyNotFoundError);
    await keys.createKey(A);
    await expect(keys.createKey(A)).rejects.toThrow('already exists');
    await keys.scheduleDestruction(A);
    await keys.scheduleDestruction(A);
    await expect(keys.createKey(A)).rejects.toThrow('already exists');
    await expect(keys.decrypt(A, new Uint8Array(40))).rejects.toBeInstanceOf(KeyDestroyedError);
  });
});

describe('InMemorySecretStore', () => {
  it('put/get/delete/paths', async () => {
    const s = new InMemorySecretStore();
    await s.put('practices/a/x/y', 'v');
    expect(s.paths()).toEqual(['practices/a/x/y']);
    await s.delete('practices/a/x/y');
    expect(await s.get('practices/a/x/y')).toBeUndefined();
  });
});
