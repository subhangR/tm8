/**
 * Password verification and the real scrypt hasher.
 *
 * Uses the production hasher (not the fast fake), so it is deliberately the
 * slowest file in the suite — a handful of hashes, not one per test.
 */

import { describe, expect, it } from 'vitest';
import {
  IdentityServiceImpl,
  InMemoryIdentityRepository,
  ManualClock,
  ScryptPasswordHasher,
  SequentialIds,
  formatToken,
  hashToken,
  parseToken,
} from '../../src/identity/index.js';
import { expectCode } from './harness.js';

function realService() {
  const repo = new InMemoryIdentityRepository();
  const service = new IdentityServiceImpl({
    repository: repo,
    clock: new ManualClock(),
    ids: new SequentialIds(),
    hasher: new ScryptPasswordHasher(),
  });
  return { repo, service };
}

describe('scrypt hasher', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const hasher = new ScryptPasswordHasher();
    const stored = await hasher.hash('correct horse battery staple');

    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('correct horse');
    expect(await hasher.verify('correct horse battery staple', stored)).toBe(true);
    expect(await hasher.verify('wrong', stored)).toBe(false);
  });

  it('salts — the same password hashes differently every time', async () => {
    const hasher = new ScryptPasswordHasher();
    const a = await hasher.hash('same-password');
    const b = await hasher.hash('same-password');

    expect(a).not.toBe(b);
    expect(await hasher.verify('same-password', a)).toBe(true);
    expect(await hasher.verify('same-password', b)).toBe(true);
  });

  it('carries its parameters so they can be raised later', async () => {
    const hasher = new ScryptPasswordHasher();
    const [algo, N, r, p] = (await hasher.hash('x')).split('$');
    expect(algo).toBe('scrypt');
    expect(Number(N)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('returns false rather than throwing on a malformed verifier', async () => {
    const hasher = new ScryptPasswordHasher();
    for (const bad of ['', 'garbage', 'scrypt$x$8$1$aa$bb', 'bcrypt$1$2$3$aa$bb', 'scrypt$16384$8$1$aa$']) {
      expect(await hasher.verify('anything', bad)).toBe(false);
    }
  });
});

describe('password authentication', () => {
  it('authenticates the owner and issues a working token', async () => {
    const { service } = realService();
    await service.bootstrapOwner({ password: 'a-real-password' });

    const ctx = await service.authenticate({ username: 'owner', password: 'a-real-password' });
    expect(ctx.token.startsWith('tm8s_')).toBe(true);
    await expect(service.verifyToken(ctx.token)).resolves.toBeDefined();
  });

  it('is case-insensitive on the login and trims it', async () => {
    const { service } = realService();
    await service.bootstrapOwner({ username: 'Ada', password: 'a-real-password' });

    await expect(
      service.authenticate({ username: '  ADA  ', password: 'a-real-password' }),
    ).resolves.toBeDefined();
  });

  it('rejects a wrong password and an unknown login identically', async () => {
    const { service } = realService();
    await service.bootstrapOwner({ password: 'a-real-password' });

    const messages = new Set<string>();
    await service
      .authenticate({ username: 'owner', password: 'wrong' })
      .catch((e: Error) => messages.add(e.message));
    await service
      .authenticate({ username: 'nobody', password: 'wrong' })
      .catch((e: Error) => messages.add(e.message));

    expect(messages.size).toBe(1);
    await expectCode(service.authenticate({ username: 'owner', password: 'wrong' }), 'unauthenticated');
  });

  it('spends comparable work on an unknown login as on a known one', async () => {
    const { service } = realService();
    await service.bootstrapOwner({ password: 'a-real-password' });

    const time = async (username: string) => {
      const start = process.hrtime.bigint();
      await service.authenticate({ username, password: 'wrong-password' }).catch(() => {});
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    // Warm up, then compare. Without the unmatchable-verifier path, "no such
    // account" returns in microseconds and enumerates accounts; the assertion is
    // deliberately loose (same order of magnitude) so it is not flaky on a busy
    // machine.
    await time('owner');
    const known = await time('owner');
    const unknown = await time('definitely-not-a-user');

    expect(unknown).toBeGreaterThan(known / 10);
  });

  it('refuses an account that has no password set', async () => {
    const { service } = realService();
    // A loopback-only node may never set one (S1+S5 carry the security).
    await service.bootstrapOwner();

    await expectCode(service.authenticate({ username: 'owner', password: '' }), 'unauthenticated');
    await expectCode(service.authenticate({ username: 'owner', password: 'guess' }), 'unauthenticated');
  });

  it('rejects an empty username outright', async () => {
    const { service } = realService();
    await service.bootstrapOwner({ password: 'a-real-password' });
    await expectCode(service.authenticate({ username: '   ', password: 'x' }), 'invalid_input');
  });
});

describe('token format', () => {
  it('round-trips through parse', () => {
    const token = formatToken('sess-1', 'secret-value');
    expect(parseToken(token)).toEqual({ sessionId: 'sess-1', secret: 'secret-value' });
  });

  it('keeps dots inside the secret', () => {
    // The secret is base64url today, but splitting on the LAST dot would break
    // the moment it is not.
    expect(parseToken(formatToken('sess-1', 'a.b.c'))).toEqual({
      sessionId: 'sess-1',
      secret: 'a.b.c',
    });
  });

  it('rejects anything without the tm8 prefix', () => {
    expect(parseToken('sess-1.secret')).toBeNull();
    expect(parseToken('bearer tm8s_a.b')).toBeNull();
  });

  it('hashes deterministically to sha256 hex', () => {
    expect(hashToken('x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('x')).toBe(hashToken('x'));
    expect(hashToken('x')).not.toBe(hashToken('y'));
  });
});
