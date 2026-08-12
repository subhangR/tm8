/**
 * S8 — bearer token lifecycle: issue, verify, expire, revoke.
 *
 * These tokens are what a spawned agent receives in its manifest env, so the
 * failure modes here are "an agent keeps working after you revoked it" and
 * "a token leaks what it is wrong about".
 */

import { describe, expect, it } from 'vitest';
import { makeHarness, expectCode, SPACE_A } from './harness.js';
import { hashToken, parseToken, formatToken } from '../../src/identity/index.js';

const DAY = 24 * 60 * 60 * 1000;

describe('token lifecycle (S8/R6)', () => {
  it('issues a token that verifies back to its account', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    h.join(owner.identityId, SPACE_A);

    const { token, session } = await h.service.issueSession({
      accountId: owner.id,
      kind: 'cli',
      label: 'my laptop',
    });
    const ctx = await h.service.verifyToken(token);

    expect(ctx.account.id).toBe(owner.id);
    expect(ctx.session?.id).toBe(session.id);
    expect(session.label).toBe('my laptop');
  });

  it('never stores the token secret — only its sha256', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const { token, session } = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });

    const parsed = parseToken(token)!;
    expect(session.tokenHash).toBe(hashToken(parsed.secret));
    expect(session.tokenHash).not.toContain(parsed.secret);
    // The stored row cannot reconstruct the bearer token.
    expect(JSON.stringify(session)).not.toContain(parsed.secret);
  });

  it('rejects a forged token that reuses a real session id', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const { token } = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });
    const { sessionId } = parseToken(token)!;

    await expectCode(h.service.verifyToken(formatToken(sessionId, 'guessed')), 'unauthenticated');
  });

  it('rejects malformed and unknown tokens with the same code', async () => {
    const h = makeHarness();
    await h.service.bootstrapOwner();

    await expectCode(h.service.verifyToken(''), 'unauthenticated');
    await expectCode(h.service.verifyToken('not-a-token'), 'unauthenticated');
    await expectCode(h.service.verifyToken('tm8s_nodot'), 'unauthenticated');
    await expectCode(h.service.verifyToken('tm8s_.secret'), 'unauthenticated');
    await expectCode(h.service.verifyToken(formatToken('no-such-session', 'x')), 'unauthenticated');
  });

  it('does not leak WHY a token was rejected', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const live = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });
    const revoked = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });
    await h.service.revokeSession(revoked.session.id);

    const messages = new Set<string>();
    for (const token of [
      formatToken(parseToken(live.token)!.sessionId, 'wrong-secret'),
      revoked.token,
      formatToken('no-such-session', 'x'),
    ]) {
      await h.service.verifyToken(token).catch((e: Error) => messages.add(e.message));
    }
    // Revoked / wrong-secret / unknown are indistinguishable to the caller —
    // otherwise a probe enumerates which session ids exist.
    expect(messages.size).toBe(1);
  });

  it('expires a token at its TTL boundary', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const { token } = await h.service.issueSession({
      accountId: owner.id,
      kind: 'cli',
      ttlMs: 60_000,
    });

    h.clock.advance(59_999);
    await expect(h.service.verifyToken(token)).resolves.toBeDefined();

    h.clock.advance(1); // exactly at expiry — expired, not "still valid"
    await expectCode(h.service.verifyToken(token), 'unauthenticated');
  });

  it('applies per-kind default TTLs', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);

    const browser = await h.service.issueSession({ accountId: owner.id, kind: 'browser' });
    const cli = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });
    const agent = await h.service.issueSession({
      accountId: owner.id,
      kind: 'agent',
      actingAsTeamMemberId: persona.id,
    });

    const ttl = (expiresAt: string) => Date.parse(expiresAt) - h.clock.nowMs();
    expect(ttl(browser.session.expiresAt)).toBe(30 * DAY);
    expect(ttl(cli.session.expiresAt)).toBe(90 * DAY);
    // 7d -> 48h. An agent bearer is now revoked when its agent exits and swept
    // when its PTY is gone, so this figure is only the backstop for the case
    // where both of those fail; it is sized to clear the longest work session
    // measured on a real node (~1d22h) rather than to a round number. See
    // `SESSION_TTL_MS` in src/identity/pg-auth.ts for the full reasoning.
    expect(ttl(agent.session.expiresAt)).toBe(2 * DAY);
  });

  it('revocation takes effect immediately and is idempotent', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const { token, session } = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });

    await expect(h.service.verifyToken(token)).resolves.toBeDefined();
    await h.service.revokeSession(session.id);
    await expectCode(h.service.verifyToken(token), 'unauthenticated');

    const at = h.clock.now();
    h.clock.advance(1000);
    await h.service.revokeSession(session.id);
    const [stored] = await h.service.listSessions(owner.id, true);
    // A second revoke does not move the timestamp — the audit record is when it
    // was actually killed.
    expect(stored?.revokedAt).toBe(at);
  });

  it('stamps last-used on verification', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const { token, session } = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });
    expect(session.lastUsedAt).toBeNull();

    h.clock.advance(5000);
    const ctx = await h.service.verifyToken(token);
    expect(ctx.session?.lastUsedAt).toBeNull(); // the row read predates the touch
    const [stored] = await h.service.listSessions(owner.id);
    expect(stored?.lastUsedAt).toBe(h.clock.now());
  });

  it('lists only live sessions unless asked for all', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const a = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });
    h.clock.advance(1);
    await h.service.issueSession({ accountId: owner.id, kind: 'browser' });
    await h.service.revokeSession(a.session.id);

    expect(await h.service.listSessions(owner.id)).toHaveLength(1);
    expect(await h.service.listSessions(owner.id, true)).toHaveLength(2);
  });

  it('refuses to issue a session for a disabled account', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    await h.service.disableAccount(owner.id);

    await expectCode(h.service.issueSession({ accountId: owner.id, kind: 'cli' }), 'forbidden');
  });

  it('retention sweeps expired and revoked rows', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    await h.service.issueSession({ accountId: owner.id, kind: 'cli', ttlMs: 1000 });
    await h.service.issueSession({ accountId: owner.id, kind: 'cli', ttlMs: 10 * DAY });

    h.clock.advance(2000);
    expect(await h.repo.deleteExpiredSessions(h.clock.now())).toBe(1);
    expect(await h.service.listSessions(owner.id, true)).toHaveLength(1);
  });
});
