import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  credentialKeyPath,
  loadOrCreateCredentialKey,
  openSecret,
  resetCredentialKeyCache,
  sealSecret,
} from '../../src/credentials/index.js';

const dirs: string[] = [];

afterEach(async () => {
  resetCredentialKeyCache();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GitHub credential encryption ported from staging 079', () => {
  it('creates one stable node-local key with mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm8-git-key-'));
    dirs.push(dir);
    const first = await loadOrCreateCredentialKey(dir);
    const second = await loadOrCreateCredentialKey(dir);
    expect(second.equals(first)).toBe(true);
    expect((await stat(credentialKeyPath(dir))).mode & 0o777).toBe(0o600);
  });

  it('round-trips only under the same account/provider AAD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm8-git-key-'));
    dirs.push(dir);
    const key = await loadOrCreateCredentialKey(dir);
    const binding = { accountId: 'account-alice', provider: 'github' };
    const one = sealSecret(key, 'synthetic-github-token', binding);
    const two = sealSecret(key, 'synthetic-github-token', binding);

    expect(one.ciphertext.equals(two.ciphertext)).toBe(false);
    expect(openSecret(key, one, binding)).toBe('synthetic-github-token');
    expect(() => openSecret(key, one, { ...binding, accountId: 'account-bob' })).toThrow();
  });
});
