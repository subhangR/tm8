// @vitest-environment jsdom
/**
 * W3-client a3, browser half — the UI's REAL transport and space-session
 * module against a REAL node started with TM8_SPACE_SESSIONS=enforce.
 *
 * Opt-in: runs only when TM8_W3C_LIVE_URL names such a node (loopback, auto-
 * owner on, so the signup below needs no credential). CI skips it; the
 * committed evidence there is `space-sessions.test.ts` plus the server's T8c
 * client-walk cells. What this adds is that the rules those fakes encode are
 * the real server's rules.
 *
 * The fetch below behaves like a browser for cookies: it sends the jar unless
 * `credentials: 'omit'`, and takes `Set-Cookie` only when it sent credentials.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { createHttpClient } from '../data/real/http';
import { LOCAL_SERVER_ID } from '../servers/server-key';
import { readSpaceSessionsEnforced, writeServerPass } from './pass-store';
import { endSpaceSessions, resetSpaceSessions, spaceSessionFor } from './space-sessions';

const LIVE = process.env.TM8_W3C_LIVE_URL ?? '';
const COOKIE = '__Host-tm8-session'; // server http/session-cookie.ts

interface Sent { path: string; status: number; bearer: string | null; cookie: string | null }

describe.skipIf(!LIVE)('a3 live: T8c under enforce through the UI transport, without logout', () => {
  const realFetch = globalThis.fetch.bind(globalThis);
  let jar: string | null = null;
  const sent: Sent[] = [];
  let gate = '';
  let spaceA = '';
  let spaceB = '';

  async function browserFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input), LIVE);
    const headers = new Headers(init.headers);
    const withCredentials = init.credentials !== 'omit';
    if (withCredentials && jar) headers.set('cookie', `${COOKIE}=${jar}`);
    const res = await realFetch(url, { ...init, headers, credentials: undefined });
    if (withCredentials) {
      const set = res.headers.get('set-cookie')?.match(new RegExp(`${COOKIE}=([^;]*)`))?.[1];
      if (set !== undefined) jar = set || null;
    }
    sent.push({
      path: url.pathname,
      status: res.status,
      bearer: headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
      cookie: withCredentials ? jar : null,
    });
    return res;
  }

  async function raw(method: string, path: string, token: string | null, body?: unknown) {
    const res = await realFetch(new URL(path, LIVE), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as any };
  }

  beforeAll(async () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
      },
    });
    vi.stubGlobal('fetch', browserFetch);
    resetSpaceSessions();

    const username = `w3cui${Math.random().toString(36).slice(2, 10)}`;
    const password = `pw-${Math.random().toString(36).slice(2)}`;
    expect((await raw('POST', '/v2/auth/signup', null, { username, password })).status).toBeLessThan(300);
    // Login as the browser does: the response sets the gate cookie.
    const login = await raw('POST', '/v2/auth/login', null, { username, password, kind: 'browser' });
    expect(login.status).toBe(200);
    gate = login.json.data.token;
    jar = login.headers.get('set-cookie')?.match(new RegExp(`${COOKIE}=([^;]*)`))?.[1] ?? null;
    expect(jar).toBe(gate);
    writeServerPass(LOCAL_SERVER_ID, {
      token: gate,
      sessionId: login.json.data.session.sessionId,
      expiresAt: login.json.data.session.expiresAt,
      signedInAt: new Date().toISOString(),
      account: {
        handle: username, displayName: username, accountId: login.json.data.account.accountId,
        identityId: login.json.data.account.identityId, isOwner: false, isNodeAdmin: false,
      },
    });
    for (const name of ['W3C UI A', 'W3C UI B']) {
      const made = await raw('POST', '/v2/spaces', gate, { name, clientMutationId: `w3cui-${name}-${Date.now()}` });
      expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
      if (name.endsWith('A')) spaceA = made.json.data.space.id;
      else spaceB = made.json.data.space.id;
    }
  }, 60_000);

  afterAll(() => {
    endSpaceSessions(LOCAL_SERVER_ID);
    vi.unstubAllGlobals();
  });

  const client = () => createHttpClient({
    fetch: (url, init) => globalThis.fetch(url, init),
    getAuthToken: () => gate,
    spaceSession: spaceSessionFor(LOCAL_SERVER_ID),
  });

  it('first read in A: refused as a gate, entered, retried, served — and enforce is learned', async () => {
    const session = spaceSessionFor(LOCAL_SERVER_ID);
    await session.enterSpace(spaceA);
    const got = await client().call<{ id: string }>('spaces.get', { params: { spaceId: spaceA } });
    expect(JSON.stringify(got)).toContain(spaceA);
    expect(sent.map((s) => [s.path, s.status])).toEqual([
      [`/v2/spaces/${spaceA}`, 403],
      ['/v2/auth/space/enter', 200],
      [`/v2/spaces/${spaceA}`, 200],
    ]);
    expect(readSpaceSessionsEnforced(LOCAL_SERVER_ID)).toBe(true);
    expect(jar).not.toBe(gate); // enter replaced the cookie with A's pin
  });

  it('switch to B without logout: enter on the switch, B served, spaces.list keeps the gate', async () => {
    sent.length = 0;
    await spaceSessionFor(LOCAL_SERVER_ID).enterSpace(spaceB);
    expect(sent.map((s) => [s.path, s.status])).toEqual([['/v2/auth/space/enter', 200]]);
    const got = await client().call('spaces.get', { params: { spaceId: spaceB } });
    expect(JSON.stringify(got)).toContain(spaceB);
    const listed = await client().call('spaces.list');
    expect(JSON.stringify(listed)).toContain(spaceA);
    expect(sent.slice(1).map((s) => [s.path, s.status, s.bearer === gate])).toEqual([
      [`/v2/spaces/${spaceB}`, 200, false],
      ['/v2/spaces', 200, true],
    ]);
  });

  it('back to A: re-entered, A served, B refused through A\'s pin; the gate never changed', async () => {
    sent.length = 0;
    await spaceSessionFor(LOCAL_SERVER_ID).enterSpace(spaceA);
    await expect(client().call('spaces.get', { params: { spaceId: spaceA } })).resolves.toBeTruthy();
    await expect(client().call('spaces.get', { params: { spaceId: spaceB } })).rejects.toThrow();
    expect(sent.some((s) => s.path === '/v2/auth/logout' && s.bearer === gate)).toBe(false);
    expect((await raw('GET', '/v2/auth/session', gate)).status).toBe(200);
  });
});
