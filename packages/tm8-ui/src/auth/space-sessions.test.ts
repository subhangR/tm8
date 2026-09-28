// @vitest-environment jsdom
/**
 * W3-client, browser half (task 01a0d9fd a1, a4).
 *
 * The fake node below keeps the two server rules the browser has to live with
 * (#848): under `enforce` a gate session is refused everything but the gate's
 * operations, and a cookie next to a DIFFERENT `Authorization` is refused as a
 * pair (identity-resolver), except on `auth.space.enter`, whose response
 * replaces the cookie. Under `agents` it refuses nothing. The assertions read
 * the requests the transport actually sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpClient } from '../data/real/http';
import { createRealSeam } from '../data/real/seam-real';
import { FakeClock, fakeSocketPool, flush, type FakeSocket } from '../data/real/test-support';
import { LOCAL_SERVER_ID } from '../servers/server-key';
import {
  SPACE_SESSIONS_ENFORCED_KEY,
  clearServerPass,
  readSpaceSessionsEnforced,
  writeServerPass,
  type ServerPass,
} from './pass-store';
import { signOutOfServer } from './session';
import {
  endSpaceSessions,
  resetSpaceSessions,
  setSpacePasswordPrompter,
  spaceSessionFor,
  type SpacePasswordPrompter,
} from './space-sessions';

const SPACE_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const SPACE_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const GATE_SESSION = '09090909-0000-4000-8000-000000000009';
const GATE = `tm8s_${GATE_SESSION}.gate-secret`;

function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const gatePass: ServerPass = {
  token: GATE,
  sessionId: GATE_SESSION,
  expiresAt: '2099-01-01T00:00:00.000Z',
  signedInAt: '2026-09-26T00:00:00.000Z',
  account: {
    handle: 'amber',
    displayName: 'amber',
    accountId: 'acc',
    identityId: 'idn',
    isOwner: false,
    isNodeAdmin: false,
  },
};

interface Sent {
  method: string;
  path: string;
  authorization: string | null;
  omitCookie: boolean;
  status: number;
}

/** A node with one gate session, a cookie jar, and `TM8_SPACE_SESSIONS=mode`. */
function fakeNode(mode: 'agents' | 'enforce', spacePasswords: Record<string, string> = {}) {
  const sent: Sent[] = [];
  let jar: string | null = GATE; // `auth.login` set the gate cookie
  let minted = 0;
  const pins = new Map<string, string>(); // token -> spaceId
  const revoked = new Set<string>();

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const refuse = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
    reply(status, { error: { code, message, requestId: 'r', ...(details ? { details } : {}) } });

  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const header = headers.authorization?.replace(/^Bearer /, '') ?? null;
    const omitCookie = init.credentials === 'omit';
    const cookie = omitCookie ? null : jar;
    const record = (status: number) =>
      sent.push({ method: init.method ?? 'GET', path, authorization: header, omitCookie, status });

    const enter = path === '/v2/auth/space/enter';
    if (header && cookie && header !== cookie && !enter) {
      record(401);
      return refuse(401, 'unauthenticated', 'credentials disagree');
    }
    const token = enter ? header : header ?? cookie;
    if (!token || revoked.has(token)) {
      record(401);
      return refuse(401, 'unauthenticated', 'invalid token');
    }
    const pinnedTo = pins.get(token) ?? null;
    const gateOp = enter || path === '/v2/spaces' || path === '/v2/auth/logout';

    if (enter) {
      if (pinnedTo) {
        record(403);
        return refuse(403, 'forbidden', 'a space-pinned session cannot enter a space; use the gate session');
      }
      const { spaceId, spacePassword } = JSON.parse(String(init.body)) as { spaceId: string; spacePassword?: string };
      // W5: a space with a password refuses without it (required) or with a wrong one (rejected).
      const needed = spacePasswords[spaceId];
      if (needed !== undefined && spacePassword !== needed) {
        record(403);
        const reason = spacePassword === undefined ? 'space_password_required' : 'space_password_rejected';
        return refuse(403, 'forbidden', 'space password', { reason });
      }
      const sessionId = `0c0c0c0c-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
      const pinned = `tm8s_${sessionId}.pin-${spaceId.slice(0, 4)}-${minted}`;
      pins.set(pinned, spaceId);
      jar = pinned; // Set-Cookie on a browser result
      record(200);
      return reply(200, {
        data: {
          token: pinned,
          spaceId,
          session: {
            sessionId,
            kind: 'browser',
            label: 'tm8 web',
            spaceId,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        },
      });
    }
    if (path === '/v2/auth/logout') {
      revoked.add(token);
      // The server always answers with a cookie-clearing Set-Cookie; a browser
      // takes it only on a request that sent credentials.
      if (!omitCookie) jar = null;
      record(200);
      return reply(200, { data: { sessionId: 'x', revoked: true } });
    }
    if (mode === 'enforce' && !pinnedTo && !gateOp) {
      record(403);
      return refuse(403, 'forbidden', 'this session is not in a space; call auth.space.enter first');
    }
    record(200);
    return reply(200, { data: { servedBy: pinnedTo ?? 'gate' } });
  });

  return {
    fetchImpl,
    sent,
    revoked,
    pinnedSpace: (t: string | null) => (t ? pins.get(t) ?? null : null),
    /** The browser's session cookie right now — what a WebSocket upgrades with. */
    jar: () => jar,
  };
}

function clientFor() {
  const session = spaceSessionFor(LOCAL_SERVER_ID);
  const client = createHttpClient({
    fetch: (url, init) => globalThis.fetch(url, init),
    getAuthToken: () => GATE,
    spaceSession: session,
  });
  return { session, client };
}

beforeEach(() => {
  installStorage();
  resetSpaceSessions();
  writeServerPass(LOCAL_SERVER_ID, gatePass);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('W3 space sessions — agents (a4: no user-visible change)', () => {
  it('never enters a space; every request is the gate pass with its cookie, as before W3', async () => {
    const node = fakeNode('agents');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();

    await session.enterSpace(SPACE_A);
    await expect(client.call('inbox.list')).resolves.toEqual({ servedBy: 'gate' });
    await session.enterSpace(SPACE_B);
    await expect(client.call('inbox.list')).resolves.toEqual({ servedBy: 'gate' });
    await expect(client.call('spaces.list')).resolves.toEqual({ servedBy: 'gate' });

    expect(node.sent.map((s) => s.path)).not.toContain('/v2/auth/space/enter');
    expect(node.sent.every((s) => s.authorization === GATE && !s.omitCookie)).toBe(true);
    expect(readSpaceSessionsEnforced(LOCAL_SERVER_ID)).toBe(false);
    expect(localStorage.getItem(SPACE_SESSIONS_ENFORCED_KEY)).toBeNull();
  });
});

describe('W3 space sessions — enforce (a1)', () => {
  it('the gate refusal mints a pinned session for the active space and the request is retried once with it', async () => {
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();

    await session.enterSpace(SPACE_A); // server not yet known to enforce: records only
    expect(node.sent).toHaveLength(0);

    await expect(client.call('inbox.list')).resolves.toEqual({ servedBy: SPACE_A });
    expect(node.sent.map((s) => [s.path, s.status])).toEqual([
      ['/v2/inbox', 403],
      ['/v2/auth/space/enter', 200],
      ['/v2/inbox', 200],
    ]);
    // The mint presented the gate pass WITH the cookie, so its Set-Cookie lands.
    expect(node.sent[1]).toMatchObject({ authorization: GATE, omitCookie: false });
    expect(node.pinnedSpace(node.sent[2]!.authorization)).toBe(SPACE_A);
    expect(readSpaceSessionsEnforced(LOCAL_SERVER_ID)).toBe(true);
  });

  it('switching space calls auth.space.enter, and subsequent requests carry that space\'s pinned token', async () => {
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();
    await session.enterSpace(SPACE_A);
    await client.call('inbox.list'); // learns enforce

    node.sent.length = 0;
    await session.enterSpace(SPACE_B);
    expect(node.sent).toHaveLength(1);
    expect(node.sent[0]).toMatchObject({ path: '/v2/auth/space/enter', authorization: GATE, status: 200 });

    await expect(client.call('inbox.list')).resolves.toEqual({ servedBy: SPACE_B });
    const read = node.sent[1]!;
    expect(node.pinnedSpace(read.authorization)).toBe(SPACE_B);
    expect(read.omitCookie).toBe(true);

    // Gate operations keep the gate pass, without the (now pinned) cookie that
    // would otherwise be refused next to it.
    await expect(client.call('spaces.list')).resolves.toEqual({ servedBy: 'gate' });
    expect(node.sent[2]).toMatchObject({ path: '/v2/spaces', authorization: GATE, omitCookie: true, status: 200 });

    // Back to A: a fresh mint, and the superseded A session is revoked.
    const firstA = [...node.revoked];
    await session.enterSpace(SPACE_A);
    await expect(client.call('inbox.list')).resolves.toEqual({ servedBy: SPACE_A });
    await vi.waitFor(() => expect(node.revoked.size).toBe(firstA.length + 1));
  });

  it('a server remembered as enforcing is entered on the switch itself, before any read', async () => {
    localStorage.setItem(SPACE_SESSIONS_ENFORCED_KEY, JSON.stringify({ [location.origin]: true }));
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();

    await session.enterSpace(SPACE_A);
    await client.call('inbox.list');
    expect(node.sent.map((s) => [s.path, s.status])).toEqual([
      ['/v2/auth/space/enter', 200],
      ['/v2/inbox', 200],
    ]);
  });

  it('a revoked pinned session is re-minted from the gate pass instead of signing the viewer out', async () => {
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();
    await session.enterSpace(SPACE_A);
    await client.call('inbox.list');
    const pin = node.sent.at(-1)!.authorization!;
    node.revoked.add(pin);

    await expect(client.call('inbox.list')).resolves.toEqual({ servedBy: SPACE_A });
    expect(node.sent.at(-1)!.authorization).not.toBe(pin);
  });

  it('sign-out revokes every pinned session with its own token, or its own cookie', async () => {
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();
    await session.enterSpace(SPACE_A);
    await client.call('inbox.list');
    await session.enterSpace(SPACE_B);
    await client.call('inbox.list');
    const pins = node.sent.filter((s) => s.status === 200 && s.path === '/v2/inbox').map((s) => s.authorization);
    expect(pins).toHaveLength(2);

    await endSpaceSessions(LOCAL_SERVER_ID);
    await vi.waitFor(() => expect(node.revoked.size).toBe(2));
    const logouts = node.sent.filter((s) => s.path === '/v2/auth/logout');
    // A's pin by its header, without the cookie; B's pin (the cookie) by the
    // cookie alone. Neither presents the gate.
    expect(logouts.every((s) => s.authorization !== GATE && s.status === 200)).toBe(true);
    expect(logouts.filter((s) => s.omitCookie).map((s) => node.pinnedSpace(s.authorization))).toEqual([SPACE_A]);
    expect(logouts.filter((s) => !s.omitCookie).map((s) => s.authorization)).toEqual([null]);
    expect(pins.every((p) => p && node.revoked.has(p))).toBe(true);
  });

  it('a mint that lands after sign-out is revoked, never used', async () => {
    localStorage.setItem(SPACE_SESSIONS_ENFORCED_KEY, JSON.stringify({ [location.origin]: true }));
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const res = await node.fetchImpl(url, init);
      if (url.endsWith('/v2/auth/space/enter')) clearServerPass(LOCAL_SERVER_ID);
      return res;
    });
    const { session } = clientFor();

    await session.enterSpace(SPACE_A);
    await vi.waitFor(() => expect(node.revoked.size).toBe(1));
    expect(session.credentialFor('inbox.list')).toBeNull();
  });
});

describe('W5 space passwords — the enter prompt', () => {
  let restore: SpacePasswordPrompter | undefined;
  afterEach(() => {
    if (restore) setSpacePasswordPrompter(restore);
    restore = undefined;
  });

  it('asks for the password on a refusal, re-asks after a wrong one, and enters with the right one', async () => {
    const node = fakeNode('enforce', { [SPACE_A]: 'pw-a' });
    vi.stubGlobal('fetch', node.fetchImpl);
    const asked: Array<[string, boolean]> = [];
    const answers = ['wrong', 'pw-a'];
    restore = setSpacePasswordPrompter(async (spaceId, rejected) => {
      asked.push([spaceId, rejected]);
      return answers.shift() ?? null;
    });
    const { session, client } = clientFor();
    await session.enterSpace(SPACE_A);

    await expect(client.call('inbox.list')).resolves.toEqual({ servedBy: SPACE_A });
    expect(asked).toEqual([[SPACE_A, false], [SPACE_A, true]]);
    expect(node.sent.filter((s) => s.path === '/v2/auth/space/enter').map((s) => s.status)).toEqual([403, 403, 200]);
  });

  it('a declined prompt leaves the space refused (no pinned session); positive: a space without a password never prompts', async () => {
    const node = fakeNode('enforce', { [SPACE_A]: 'pw-a' });
    vi.stubGlobal('fetch', node.fetchImpl);
    let prompts = 0;
    restore = setSpacePasswordPrompter(async () => {
      prompts += 1;
      return null;
    });
    const { session, client } = clientFor();
    await session.enterSpace(SPACE_A);
    await expect(client.call('inbox.list')).rejects.toMatchObject({ code: 'forbidden' });
    expect(prompts).toBe(1);
    expect(node.sent.filter((s) => s.path === '/v2/auth/space/enter').map((s) => s.status)).toEqual([403]);

    await session.enterSpace(SPACE_B);
    await expect(client.call('inbox.list')).resolves.toEqual({ servedBy: SPACE_B });
    expect(prompts).toBe(1);
  });
});

describe('enforce-flip precondition F1: the event socket follows the space', () => {
  /**
   * The node's socket rule (control.ts): a browser WebSocket authenticates
   * ONCE, with the cookie it upgrades with, and a socket pinned to one space
   * is refused a subscribe to any other. `upgradedAs[i]` is socket i's
   * identity; `serve` answers each subscribe frame the way the node would.
   */
  function socketRule(node: ReturnType<typeof fakeNode>) {
    const pool = fakeSocketPool();
    const upgradedAs: Array<string | null> = [];
    const factory = (url: string) => {
      upgradedAs.push(node.jar());
      return pool.factory(url);
    };
    const refusedOn = new Map<FakeSocket, string[]>();
    const serve = () => {
      pool.sockets.forEach((socket, i) => {
        const pinnedTo = node.pinnedSpace(upgradedAs[i] ?? null);
        const already = refusedOn.get(socket) ?? [];
        for (const frame of socket.frames()) {
          if (frame.type !== 'subscribe') continue;
          for (const spaceId of frame.spaceIds as string[]) {
            if (spaceId === pinnedTo || already.includes(spaceId)) continue;
            already.push(spaceId);
            socket.deliver({ type: 'control.refused', frame: 'subscribe', spaceId, reason: 'forbidden' });
          }
        }
        refusedOn.set(socket, already);
      });
    };
    return { pool, upgradedAs, factory, serve };
  }

  /** The fake node, plus the two reads `openSpace` makes, answered as empty. */
  function seamFetch(node: ReturnType<typeof fakeNode>) {
    return async (url: string, init?: RequestInit) => {
      const res = await node.fetchImpl(url, init);
      if (res.status !== 200) return res;
      const path = new URL(url, 'http://localhost').pathname;
      const data = path.endsWith('/events')
        ? { items: [], nextCursor: '0' }
        : path.endsWith('/execution/liveness')
          ? { liveEntityIds: [], nodeBootId: 'boot', checkedAt: '2026-09-28T00:00:00.000Z' }
          : null;
      return data ? new Response(JSON.stringify({ data }), { status: 200 }) : res;
    };
  }

  it('enter B, then subscribe B succeeds: the socket reconnects as B\'s pinned session', async () => {
    localStorage.setItem(SPACE_SESSIONS_ENFORCED_KEY, JSON.stringify({ [location.origin]: true }));
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', node.fetchImpl);
    const rule = socketRule(node);
    const clock = new FakeClock();
    const session = spaceSessionFor(LOCAL_SERVER_ID);
    const seam = createRealSeam({
      baseUrl: '',
      wsUrl: 'ws://fake.invalid/v2/ws',
      fetch: seamFetch(node),
      webSocketFactory: rule.factory,
      getAuthToken: () => GATE,
      spaceSession: session,
      timers: clock.timers,
      now: clock.now,
      random: clock.random,
    });
    const refused: string[] = [];
    seam.realControls.onSpaceRefused((spaceId) => refused.push(spaceId));

    // Boot in A, the way useGateData does it: enter, then open.
    await session.enterSpace(SPACE_A);
    await seam.openSpace(SPACE_A as never);
    rule.pool.last().openIt();
    rule.serve();
    expect(refused).toEqual([]);

    // Switch to B: close A, enter B (the cookie becomes B's pin), open B.
    seam.closeSpace(SPACE_A as never);
    await session.enterSpace(SPACE_B);
    await seam.openSpace(SPACE_B as never);
    const live = rule.pool.last();
    if (live.readyState !== 1) live.openIt();
    await flush();
    rule.serve();

    expect(refused).toEqual([]);
    const subscribedB = live.frames().some((f) => f.type === 'subscribe' && (f.spaceIds as string[]).includes(SPACE_B));
    expect(subscribedB).toBe(true);
    expect(node.pinnedSpace(rule.upgradedAs[rule.pool.sockets.indexOf(live)] ?? null)).toBe(SPACE_B);
    // The A socket was closed by the client, not left to be refused.
    expect(rule.pool.sockets[0]!.closeCalls).toBe(1);

    seam.dispose();
  });

  it('under agents nothing is minted, so the socket is never replaced', async () => {
    const node = fakeNode('agents');
    vi.stubGlobal('fetch', node.fetchImpl);
    const rule = socketRule(node);
    const clock = new FakeClock();
    const session = spaceSessionFor(LOCAL_SERVER_ID);
    const seam = createRealSeam({
      baseUrl: '',
      wsUrl: 'ws://fake.invalid/v2/ws',
      fetch: seamFetch(node),
      webSocketFactory: rule.factory,
      getAuthToken: () => GATE,
      spaceSession: session,
      timers: clock.timers,
      now: clock.now,
      random: clock.random,
    });

    await session.enterSpace(SPACE_A);
    await seam.openSpace(SPACE_A as never);
    rule.pool.last().openIt();
    seam.closeSpace(SPACE_A as never);
    await session.enterSpace(SPACE_B);
    await seam.openSpace(SPACE_B as never);

    expect(rule.pool.sockets).toHaveLength(1);
    expect(rule.pool.sockets[0]!.closeCalls).toBe(0);
    seam.dispose();
  });
});

describe('enforce-flip precondition F2: sign-out clears the pinned cookie', () => {
  it('a cookie-carrying logout clears the pinned cookie, and lands before the gate logout', async () => {
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();
    await session.enterSpace(SPACE_A);
    await client.call('inbox.list'); // learns enforce
    await session.enterSpace(SPACE_B);
    expect(node.pinnedSpace(node.jar())).toBe(SPACE_B);

    signOutOfServer();

    await vi.waitFor(() => expect(node.revoked.has(GATE)).toBe(true));
    expect(node.jar()).toBeNull();
    const logouts = node.sent.filter((s) => s.path === '/v2/auth/logout');
    const byCookie = logouts.findIndex((s) => s.authorization === null && !s.omitCookie);
    const byGate = logouts.findIndex((s) => s.authorization === GATE);
    expect(byCookie).toBeGreaterThanOrEqual(0);
    expect(byCookie).toBeLessThan(byGate);
    // The gate's own logout still goes without the cookie, and nothing is refused.
    expect(logouts[byGate]!.omitCookie).toBe(true);
    expect(logouts.every((s) => s.status === 200)).toBe(true);
  });

  it('under agents sign-out is what it was: one gate logout, cookie included, no cookie-only call', async () => {
    const node = fakeNode('agents');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();
    await session.enterSpace(SPACE_A);
    await client.call('inbox.list');

    signOutOfServer();

    await vi.waitFor(() => expect(node.revoked.has(GATE)).toBe(true));
    const logouts = node.sent.filter((s) => s.path === '/v2/auth/logout');
    expect(logouts).toHaveLength(1);
    expect(logouts[0]).toMatchObject({ authorization: GATE, omitCookie: false, status: 200 });
  });
});
