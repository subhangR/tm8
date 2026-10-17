/**
 * A session cookie this node does not know is no cookie.
 *
 * Cookies are scoped by host, never by port, so every tm8 node on 127.0.0.1
 * (7778, a scratch server, a lane's UI preview) receives `__Host-tm8-session`
 * from whichever node signed the browser in last. The resolver used to treat
 * that foreign or dead token as a failed sign-in, which put a password card in
 * front of the loopback owner on every new local node.
 *
 * The database is a stub that knows exactly the tokens it is given; any other
 * well-formed token resolves to no row, which is `resolveBearerIdentity`'s
 * invalid-token rejection.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/types.js';
import { createSessionIdentityResolver } from '../src/http/identity-resolver.js';
import { TM8_SESSION_COOKIE } from '../src/http/session-cookie.js';
import { formatToken, generateSecret, hashToken } from '../src/identity/crypto.js';
import type { LoopbackOwner } from '../src/identity/loopback.js';

const OWNER: LoopbackOwner = {
  identityId: 'identity-owner', accountId: 'account-owner', username: 'owner', isNodeAdmin: true, isOwner: true,
};
const LOOPBACK = { remoteAddress: '127.0.0.1', disableAutoOwner: false };

function session(identityId: string) {
  const sessionId = randomUUID();
  const secret = generateSecret();
  return {
    token: formatToken(sessionId, secret),
    hash: hashToken(secret),
    row: {
      sessionId, accountId: `account-${identityId}`, identityId, username: identityId, displayName: null,
      isNodeAdmin: false, isOwner: false, kind: 'browser', actingAsTeamMemberId: null,
      workSessionId: null, runtimeMemberId: null, runtimeThreadRootId: null, runtimeChatId: null,
      spaceId: null, viaLinkId: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), label: null,
    },
  };
}

function resolverFor(known: ReturnType<typeof session>[], options: { failDb?: boolean } = {}) {
  const resolutions: string[] = [];
  const q = {
    rpc: async (name: string, args: readonly unknown[] = []) => {
      if (name !== 'resolve_auth_session') return null;
      if (options.failDb) throw new Error('connection reset');
      resolutions.push(String(args[0]));
      return known.find((s) => s.hash === args[0])?.row ?? null;
    },
  };
  const db = { tx: async (_claims: unknown, fn: (querier: typeof q) => unknown) => fn(q) } as unknown as Db;
  return { resolver: createSessionIdentityResolver({ db, owner: async () => OWNER }), resolutions };
}

const cookie = (token: string) => ({ cookie: `${TM8_SESSION_COOKIE}=${token}` });
const foreign = () => session('someone-on-another-node').token;

describe('a session cookie this node does not know', () => {
  it('lets the loopback owner in instead of demanding a sign-in', async () => {
    const { resolver } = resolverFor([]);
    expect(await resolver(cookie(foreign()), LOOPBACK)).toMatchObject({
      kind: 'auto-owner', identityId: OWNER.identityId,
    });
  });

  it('grants a network caller nothing: it is anonymous, as with no cookie', async () => {
    const { resolver } = resolverFor([]);
    expect(await resolver(cookie(foreign()), { remoteAddress: '10.0.0.8', disableAutoOwner: false }))
      .toEqual({ kind: 'anonymous' });
  });

  it('yields to a valid Authorization instead of conflicting with it', async () => {
    const human = session('human');
    const { resolver } = resolverFor([human]);
    expect(await resolver({ ...cookie(foreign()), authorization: `Bearer ${human.token}` }, LOOPBACK))
      .toMatchObject({ kind: 'bearer', identityId: 'human' });
  });

  it('still refuses an invalid Authorization: that carrier is chosen, not ambient', async () => {
    const { resolver } = resolverFor([]);
    await expect(resolver({ authorization: `Bearer ${foreign()}` }, LOOPBACK))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('still refuses two LIVE credentials that disagree', async () => {
    const a = session('a');
    const b = session('b');
    const { resolver } = resolverFor([a, b]);
    await expect(resolver({ ...cookie(a.token), authorization: `Bearer ${b.token}` }, LOOPBACK))
      .rejects.toThrow('conflicting authentication credentials');
  });

  it('resolves a known cookie once, as before', async () => {
    const human = session('human');
    const { resolver, resolutions } = resolverFor([human]);
    expect(await resolver(cookie(human.token), LOOPBACK)).toMatchObject({ kind: 'bearer', identityId: 'human' });
    expect(resolutions).toHaveLength(1);
  });

  it('does not mistake a database failure for a dead cookie', async () => {
    const { resolver } = resolverFor([], { failDb: true });
    await expect(resolver(cookie(foreign()), LOOPBACK)).rejects.toThrow('connection reset');
  });
});
