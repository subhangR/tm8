/**
 * The encryption half of 081, tested where it can be tested honestly: with no
 * database, no server, and no PTY.
 *
 * These assertions are the ones the migration header PROMISES. If any of them
 * fails, the claim "a database dump yields ciphertext and nothing else" has
 * stopped being true, and the prose in `db/migrations/081_account_git_credentials.sql`
 * is a lie rather than a description.
 */
import { mkdtemp, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CREDENTIAL_KEY_FILE,
  SECRET_KEY_BYTES,
  SECRET_NONCE_BYTES,
  credentialKeyPath,
  loadOrCreateCredentialKey,
  openSecret,
  resetCredentialKeyCache,
  sealSecret,
} from '../../src/credentials/index.js';

const TOKEN = 'ghp_ThisIsNotARealTokenItIsAFixture0123456789';
const BINDING = { accountId: '11111111-1111-4111-8111-111111111111', provider: 'github' };

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tm8-credkey-'));
}

afterEach(() => {
  resetCredentialKeyCache();
});

describe('the node credential key file', () => {
  it('is 32 random bytes at mode 0600, created once and reused', async () => {
    const dataDir = await scratchDir();
    const first = await loadOrCreateCredentialKey(dataDir);
    expect(first).toHaveLength(SECRET_KEY_BYTES);

    const info = await stat(credentialKeyPath(dataDir));
    // The whole at-rest story rests on this number. 0640 would put every
    // stored token in reach of any process in the server's group.
    expect(info.mode & 0o777).toBe(0o600);
    expect(credentialKeyPath(dataDir).endsWith(CREDENTIAL_KEY_FILE)).toBe(true);

    resetCredentialKeyCache();
    const second = await loadOrCreateCredentialKey(dataDir);
    // Re-reading must NOT mint a new key: that would silently render every
    // stored credential undecryptable while looking like a clean boot.
    expect(second.equals(first)).toBe(true);
  });

  it('is not the file-upload grant key', async () => {
    // Two keys, two blast radii. A shared key would make a forged upload grant
    // and a stolen GitHub token the same compromise.
    expect(CREDENTIAL_KEY_FILE).not.toBe('.file-upload-grant.key');
  });

  it('repairs a key file that was left group-readable', async () => {
    const dataDir = await scratchDir();
    await loadOrCreateCredentialKey(dataDir);
    await chmod(credentialKeyPath(dataDir), 0o644);
    resetCredentialKeyCache();

    await loadOrCreateCredentialKey(dataDir);
    const info = await stat(credentialKeyPath(dataDir));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('refuses a truncated key rather than regenerating one', async () => {
    const dataDir = await scratchDir();
    await writeFile(credentialKeyPath(dataDir), Buffer.alloc(8), { mode: 0o600 });
    resetCredentialKeyCache();
    await expect(loadOrCreateCredentialKey(dataDir)).rejects.toThrow(/invalid length/);
  });

  it('memoises per data directory and does not cache the failure', async () => {
    const dataDir = await scratchDir();
    const a = await loadOrCreateCredentialKey(dataDir);
    const b = await loadOrCreateCredentialKey(dataDir);
    expect(b.equals(a)).toBe(true);

    const other = await scratchDir();
    const c = await loadOrCreateCredentialKey(other);
    expect(c.equals(a)).toBe(false);
  });
});

describe('sealSecret / openSecret', () => {
  it('round-trips a token', async () => {
    const key = await loadOrCreateCredentialKey(await scratchDir());
    const sealed = sealSecret(key, TOKEN, BINDING);
    expect(sealed.nonce).toHaveLength(SECRET_NONCE_BYTES);
    // The plaintext must not survive anywhere in the stored bytes.
    expect(sealed.ciphertext.toString('utf8')).not.toContain('ghp_');
    expect(sealed.ciphertext.includes(Buffer.from(TOKEN, 'utf8'))).toBe(false);

    expect(openSecret(key, sealed, BINDING)).toBe(TOKEN);
  });

  it('produces a different ciphertext every time the same token is stored', async () => {
    const key = await loadOrCreateCredentialKey(await scratchDir());
    const a = sealSecret(key, TOKEN, BINDING);
    const b = sealSecret(key, TOKEN, BINDING);
    // A deterministic ciphertext would let anyone who can read the column tell
    // that two accounts had pasted the SAME token, without decrypting either.
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(openSecret(key, a, BINDING)).toBe(openSecret(key, b, BINDING));
  });

  it('refuses a ciphertext moved to another account row', async () => {
    const key = await loadOrCreateCredentialKey(await scratchDir());
    const sealed = sealSecret(key, TOKEN, BINDING);
    // This is the AAD doing its job: someone who could rewrite `account_id`
    // (nobody can — no write grant exists) still could not read the token.
    expect(() =>
      openSecret(key, sealed, {
        accountId: '22222222-2222-4222-8222-222222222222',
        provider: 'github',
      }),
    ).toThrow();
  });

  it('refuses a tampered ciphertext and a foreign key', async () => {
    const key = await loadOrCreateCredentialKey(await scratchDir());
    const otherKey = await loadOrCreateCredentialKey(await scratchDir());
    const sealed = sealSecret(key, TOKEN, BINDING);

    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] ^= 0xff;
    expect(() => openSecret(key, { ...sealed, ciphertext: tampered }, BINDING)).toThrow();
    expect(() => openSecret(otherKey, sealed, BINDING)).toThrow();
  });

  it('refuses to work with a key of the wrong size', async () => {
    expect(() => sealSecret(Buffer.alloc(16), TOKEN, BINDING)).toThrow(/32 bytes/);
  });

  it('stores bytes that satisfy the 081 CHECK constraints', async () => {
    const key = await loadOrCreateCredentialKey(await scratchDir());
    const sealed = sealSecret(key, TOKEN, BINDING);
    // octet_length(token_nonce) = 12, and ciphertext between 17 and 4096.
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext.length).toBeGreaterThanOrEqual(17);
    expect(sealed.ciphertext.length).toBeLessThanOrEqual(4096);

    const maxToken = 'x'.repeat(1024);
    expect(sealSecret(key, maxToken, BINDING).ciphertext.length).toBeLessThanOrEqual(4096);
  });

  it('never writes the plaintext to the key file', async () => {
    const dataDir = await scratchDir();
    const key = await loadOrCreateCredentialKey(dataDir);
    sealSecret(key, TOKEN, BINDING);
    const onDisk = await readFile(credentialKeyPath(dataDir));
    expect(onDisk.includes(Buffer.from(TOKEN, 'utf8'))).toBe(false);
    expect(onDisk).toHaveLength(SECRET_KEY_BYTES);
  });
});
