/** Cryptographic and filesystem promises made by migration 093. */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CREDENTIAL_KEY_FILE,
  credentialKeyPath,
  loadOrCreateCredentialKey,
  resetCredentialKeyCache,
} from '../../src/credentials/credential-key.js';
import {
  openSecret,
  sealSecret,
  SECRET_KEY_BYTES,
  SECRET_NONCE_BYTES,
} from '../../src/credentials/secret-box.js';

const TOKEN = `ghp_${'F'.repeat(36)}`;
const BINDING = { accountId: '11111111-1111-4111-8111-111111111111', provider: 'github' };
const scratch: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm8-github-key-'));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  resetCredentialKeyCache();
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GitHub credential key', () => {
  it('is a distinct 32-byte 0600 file and is reused after cache reset', async () => {
    const dir = await scratchDir();
    const first = await loadOrCreateCredentialKey(dir);
    expect(first).toHaveLength(SECRET_KEY_BYTES);
    expect(CREDENTIAL_KEY_FILE).not.toBe('.file-upload-grant.key');
    expect((await stat(credentialKeyPath(dir))).mode & 0o777).toBe(0o600);

    resetCredentialKeyCache();
    const second = await loadOrCreateCredentialKey(dir);
    expect(second.equals(first)).toBe(true);
  });

  it('repairs a permissive mode and refuses a truncated key', async () => {
    const repairDir = await scratchDir();
    await loadOrCreateCredentialKey(repairDir);
    await chmod(credentialKeyPath(repairDir), 0o644);
    resetCredentialKeyCache();
    await loadOrCreateCredentialKey(repairDir);
    expect((await stat(credentialKeyPath(repairDir))).mode & 0o777).toBe(0o600);

    const brokenDir = await scratchDir();
    await writeFile(credentialKeyPath(brokenDir), Buffer.alloc(8), { mode: 0o600 });
    resetCredentialKeyCache();
    await expect(loadOrCreateCredentialKey(brokenDir)).rejects.toThrow(/invalid length/);
  });
});

describe('GitHub secret sealing', () => {
  it('round-trips without plaintext in ciphertext or the key file', async () => {
    const dir = await scratchDir();
    const key = await loadOrCreateCredentialKey(dir);
    const sealed = sealSecret(key, TOKEN, BINDING);
    expect(sealed.nonce).toHaveLength(SECRET_NONCE_BYTES);
    expect(sealed.ciphertext.includes(Buffer.from(TOKEN))).toBe(false);
    expect(await readFile(credentialKeyPath(dir))).not.toContain(Buffer.from(TOKEN));
    expect(openSecret(key, sealed, BINDING)).toBe(TOKEN);
  });

  it('uses a fresh nonce and refuses moved, tampered, or foreign-key ciphertext', async () => {
    const key = await loadOrCreateCredentialKey(await scratchDir());
    const otherKey = await loadOrCreateCredentialKey(await scratchDir());
    const first = sealSecret(key, TOKEN, BINDING);
    const second = sealSecret(key, TOKEN, BINDING);
    expect(second.nonce.equals(first.nonce)).toBe(false);
    expect(second.ciphertext.equals(first.ciphertext)).toBe(false);

    expect(() => openSecret(key, first, { ...BINDING, accountId: 'account-b' })).toThrow();
    const tampered = Buffer.from(first.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => openSecret(key, { ...first, ciphertext: tampered }, BINDING)).toThrow();
    expect(() => openSecret(otherKey, first, BINDING)).toThrow();
  });
});
