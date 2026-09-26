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
import { LOCAL_SERVER_ID } from '../servers/server-key';
import {
  SPACE_SESSIONS_ENFORCED_KEY,
  clearServerPass,
  readSpaceSessionsEnforced,
  writeServerPass,
  type ServerPass,
} from './pass-store';
import { endSpaceSessions, resetSpaceSessions, spaceSessionFor } from './space-sessions';

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
function fakeNode(mode: 'agents' | 'enforce') {
  const sent: Sent[] = [];
  let jar: string | null = GATE; // `auth.login` set the gate cookie
  let minted = 0;
  const pins = new Map<string, string>(); // token -> spaceId
  const revoked = new Set<string>();

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const refuse = (status: number, code: string, message: string) =>
    reply(status, { error: { code, message, requestId: 'r' } });

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
      const spaceId = (JSON.parse(String(init.body)) as { spaceId: string }).spaceId;
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

  return { fetchImpl, sent, revoked, pinnedSpace: (t: string | null) => (t ? pins.get(t) ?? null : null) };
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

  it('sign-out revokes every pinned session with its own token', async () => {
    const node = fakeNode('enforce');
    vi.stubGlobal('fetch', node.fetchImpl);
    const { session, client } = clientFor();
    await session.enterSpace(SPACE_A);
    await client.call('inbox.list');
    await session.enterSpace(SPACE_B);
    const pins = node.sent.filter((s) => s.status === 200 && s.path === '/v2/inbox').map((s) => s.authorization);

    endSpaceSessions(LOCAL_SERVER_ID);
    await vi.waitFor(() => expect(node.revoked.size).toBe(2));
    const logouts = node.sent.filter((s) => s.path === '/v2/auth/logout');
    expect(logouts.every((s) => s.omitCookie && s.authorization !== GATE)).toBe(true);
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
