import { createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  CaptureKeyPair,
  CaptureSealError,
  decryptSecretVersion,
  encryptSecretVersion,
  KmsRefusedError,
  KmsUnavailableError,
  LocalDevKms,
  openWithKey,
  sealCapture,
  sealWithKey,
  SecretMaterial,
  UnavailableKms,
  VaultCryptoError,
} from '../src/index.js';

const CANARY = 'tm8-canary-value-7f3a9c';
const parts = { itemId: 'item-1', ownerId: 'owner-1', version: 1 };
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('SecretMaterial', () => {
  it('never serializes its value', () => {
    const secret = SecretMaterial.fromUtf8(CANARY);
    const rendered = [JSON.stringify({ secret }), String(secret), `${secret}`, inspect(secret), inspect({ nested: { secret } })];
    for (const text of rendered) expect(text).not.toContain(CANARY);
    expect(secret.utf8()).toBe(CANARY);
  });

  it('zeroizes on dispose and refuses use afterwards', () => {
    const bytes = Buffer.from(CANARY, 'utf8');
    const secret = SecretMaterial.adopt(bytes);
    secret.dispose();
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(() => secret.utf8()).toThrow(/after dispose/);
    expect(secret.disposed).toBe(true);
  });

  it('compares in constant time without exposing values', () => {
    expect(SecretMaterial.fromUtf8('abc').equals(SecretMaterial.fromUtf8('abc'))).toBe(true);
    expect(SecretMaterial.fromUtf8('abc').equals(SecretMaterial.fromUtf8('abd'))).toBe(false);
    expect(SecretMaterial.fromUtf8('abc').equals(SecretMaterial.fromUtf8('abcd'))).toBe(false);
  });
});

describe('envelope encryption (MSG 4, R3)', () => {
  it('round-trips and stores no plaintext', async () => {
    const kms = LocalDevKms.ephemeral();
    const record = await encryptSecretVersion(kms, SecretMaterial.fromUtf8(CANARY), parts);
    for (const field of [record.wrappedDek, record.nonce, record.ciphertext]) {
      expect(field.toString('latin1')).not.toContain(CANARY);
      expect(field.toString('base64')).not.toContain(Buffer.from(CANARY).toString('base64'));
    }
    const out = await decryptSecretVersion(kms, record, parts);
    expect(out.utf8()).toBe(CANARY);
    out.dispose();
  });

  it('uses a fresh DEK and nonce for every version', async () => {
    const kms = LocalDevKms.ephemeral();
    const a = await encryptSecretVersion(kms, SecretMaterial.fromUtf8(CANARY), parts);
    const b = await encryptSecretVersion(kms, SecretMaterial.fromUtf8(CANARY), parts);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it.each([
    ['another item', { ...parts, itemId: 'item-2' }],
    ['another owner', { ...parts, ownerId: 'owner-2' }],
    ['another version', { ...parts, version: 2 }],
  ])('refuses a row swapped to %s', async (_label, swapped) => {
    const kms = LocalDevKms.ephemeral();
    const record = await encryptSecretVersion(kms, SecretMaterial.fromUtf8(CANARY), parts);
    await expect(decryptSecretVersion(kms, record, swapped)).rejects.toBeInstanceOf(KmsRefusedError);
  });

  it('refuses a tampered ciphertext with one generic error', async () => {
    const kms = LocalDevKms.ephemeral();
    const record = await encryptSecretVersion(kms, SecretMaterial.fromUtf8(CANARY), parts);
    const tampered = { ...record, ciphertext: Buffer.from(record.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] as number) ^ 1;
    const error = await decryptSecretVersion(kms, tampered, parts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultCryptoError);
    expect((error as VaultCryptoError).code).toBe('decrypt_failed');
    expect(String((error as Error).message)).not.toContain(CANARY);
  });

  it('acceptance 14: the DB rows alone yield nothing once the KEK is gone', async () => {
    const kms = LocalDevKms.ephemeral();
    const record = await encryptSecretVersion(kms, SecretMaterial.fromUtf8(CANARY), parts);
    kms.destroyForTest();
    await expect(decryptSecretVersion(kms, record, parts)).rejects.toBeInstanceOf(KmsRefusedError);
    // Brute force is not a path either: the value is under a random 256-bit DEK.
    expect(() => openWithKey(Buffer.alloc(32), record.nonce, record.ciphertext, Buffer.alloc(0))).toThrow(VaultCryptoError);
  });

  it('rejects AAD parts that could collide', async () => {
    const kms = LocalDevKms.ephemeral();
    await expect(encryptSecretVersion(kms, SecretMaterial.fromUtf8('x'), { ...parts, itemId: 'a|b' })).rejects.toBeInstanceOf(VaultCryptoError);
    await expect(encryptSecretVersion(kms, SecretMaterial.fromUtf8('x'), { ...parts, version: 0 })).rejects.toBeInstanceOf(VaultCryptoError);
  });

  it('failure case 5: an unavailable KMS fails closed on capture and on use', async () => {
    const kms = new UnavailableKms();
    await expect(encryptSecretVersion(kms, SecretMaterial.fromUtf8(CANARY), parts)).rejects.toBeInstanceOf(KmsUnavailableError);
    expect((await kms.health()).ok).toBe(false);
  });
});

/**
 * Records each Decipheriv#update() output object, with a copy of what it held when returned. GCM's
 * update() releases plaintext before final() checks the tag (review F05).
 */
function recordUpdates() {
  const proto = Object.getPrototypeOf(createDecipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12))) as {
    update(...args: unknown[]): Buffer;
  };
  const original = proto.update;
  const outputs: { buffer: Buffer; held: Buffer }[] = [];
  const spy = vi.spyOn(proto, 'update').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const buffer = original.apply(this, args);
    outputs.push({ buffer, held: Buffer.from(buffer) });
    return buffer;
  });
  return { outputs, restore: () => spy.mockRestore() };
}

const zero = (bytes: Buffer) => bytes.every((byte) => byte === 0);

describe('GCM decryption leaves one plaintext copy (review F05)', () => {
  const value = Buffer.from(`${CANARY}-gcm`);

  it('a value under the wrong AAD: the released plaintext is wiped; success returns update()\'s own buffer', () => {
    const key = randomBytes(32);
    const { nonce, ciphertext } = sealWithKey(key, value, Buffer.from('aad-a'));
    const updates = recordUpdates();
    try {
      expect(() => openWithKey(key, nonce, ciphertext, Buffer.from('aad-b'))).toThrow(VaultCryptoError);
      expect(updates.outputs).toHaveLength(1);
      expect(updates.outputs[0]!.held).toEqual(value);
      expect(zero(updates.outputs[0]!.buffer)).toBe(true);
      const opened = openWithKey(key, nonce, ciphertext, Buffer.from('aad-a'));
      expect(opened).toEqual(value);
      expect(opened).toBe(updates.outputs[1]!.buffer);
    } finally {
      updates.restore();
    }
  });

  it('a local-dev wrapped DEK under the wrong AAD: the released DEK is wiped', async () => {
    const kms = LocalDevKms.ephemeral();
    const dek = randomBytes(32);
    const wrapped = await kms.wrap(dek, Buffer.from('aad-a'));
    const updates = recordUpdates();
    try {
      await expect(kms.unwrap(wrapped, Buffer.from('aad-b'))).rejects.toBeInstanceOf(KmsRefusedError);
      expect(updates.outputs[0]!.held).toEqual(dek);
      expect(zero(updates.outputs[0]!.buffer)).toBe(true);
      const unwrapped = await kms.unwrap(wrapped, Buffer.from('aad-a'));
      expect(unwrapped).toEqual(dek);
      expect(unwrapped).toBe(updates.outputs[1]!.buffer);
    } finally {
      updates.restore();
    }
  });

  it('a capture envelope with a forged tag: the released value is wiped', () => {
    const broker = CaptureKeyPair.generate();
    const sealed = sealCapture(value, broker.publicKey(), 'cap_0123456789');
    const forged = Buffer.from(sealed.ct, 'base64url');
    forged[forged.length - 1]! ^= 1;
    const updates = recordUpdates();
    try {
      expect(() => broker.open({ ...sealed, ct: forged.toString('base64url') }, 'cap_0123456789')).toThrow(CaptureSealError);
      expect(updates.outputs[0]!.held).toEqual(value);
      expect(zero(updates.outputs[0]!.buffer)).toBe(true);
      const opened = broker.open(sealed, 'cap_0123456789');
      expect(opened).toEqual(value);
      expect(opened).toBe(updates.outputs[1]!.buffer);
    } finally {
      updates.restore();
    }
  });
});

describe('LocalDevKms key file', () => {
  function dir(): string {
    const d = mkdtempSync(join(tmpdir(), 'vault-kms-'));
    dirs.push(d);
    return d;
  }

  it('creates a 0600 key once and reloads the same KEK', async () => {
    const path = join(dir(), 'kek');
    const first = LocalDevKms.fromFile(path);
    const record = await encryptSecretVersion(first, SecretMaterial.fromUtf8(CANARY), parts);
    const second = LocalDevKms.fromFile(path);
    expect(second.activeKekId).toBe(first.activeKekId);
    expect((await decryptSecretVersion(second, record, parts)).utf8()).toBe(CANARY);
    expect(first.productionGrade).toBe(false);
  });

  it('refuses a group-readable key, a wrong size and a symlink', () => {
    const d = dir();
    const loose = join(d, 'loose');
    writeFileSync(loose, Buffer.alloc(32, 1));
    chmodSync(loose, 0o640);
    expect(() => LocalDevKms.fromFile(loose)).toThrow(KmsRefusedError);
    const short = join(d, 'short');
    writeFileSync(short, Buffer.alloc(16, 1), { mode: 0o600 });
    expect(() => LocalDevKms.fromFile(short)).toThrow(KmsRefusedError);
    const target = join(d, 'target');
    writeFileSync(target, Buffer.alloc(32, 1), { mode: 0o600 });
    const link = join(d, 'link');
    symlinkSync(target, link);
    expect(() => LocalDevKms.fromFile(link)).toThrow();
  });
});
