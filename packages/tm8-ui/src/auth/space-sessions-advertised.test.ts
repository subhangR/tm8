// @vitest-environment jsdom
/**
 * `identity.get` advertises the node's `TM8_SPACE_SESSIONS` mode (task
 * 01a0db30-564e). The browser reads it through the REAL seam, so under
 * `enforce` the first space switch mints a pinned session up front instead of
 * learning the mode from a 403; under `agents` / `off` it pins nothing and a
 * marker left from before is forgotten. A node that omits the field changes
 * nothing (the 403 path still teaches the client).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRealSeam } from '../data/real/seam-real';
import { FakeClock, fakeFetch, fakeSocketPool } from '../data/real/test-support';
import { LOCAL_SERVER_ID } from '../servers/server-key';
import {
  noteSpaceSessionsEnforced,
  readSpaceSessionsEnforced,
  writeServerPass,
  type ServerPass,
} from './pass-store';
import { resetSpaceSessions, spaceSessionFor } from './space-sessions';

const SPACE_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const GATE_SESSION = '09090909-0000-4000-8000-000000000009';
const GATE = `tm8s_${GATE_SESSION}.gate-secret`;

const gatePass: ServerPass = {
  token: GATE,
  sessionId: GATE_SESSION,
  expiresAt: '2099-01-01T00:00:00.000Z',
  signedInAt: '2026-09-28T00:00:00.000Z',
  account: {
    handle: 'amber',
    displayName: 'amber',
    accountId: 'acc',
    identityId: 'idn',
    isOwner: false,
    isNodeAdmin: false,
  },
};

const IDENTITY = {
  identityId: 'idn',
  accountId: 'acc',
  username: 'amber',
  displayName: 'amber',
  avatar: null,
  email: null,
  globalId: null,
  isNodeAdmin: false,
  isOwner: false,
  status: 'active',
  actingAs: null,
  memberships: [],
};

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

/** The seam as the app builds it, answering `identity.get` with `spaceSessions`. */
function seamAdvertising(spaceSessions: 'off' | 'agents' | 'enforce' | undefined) {
  const clock = new FakeClock();
  const f = fakeFetch(() => ({ data: spaceSessions === undefined ? IDENTITY : { ...IDENTITY, spaceSessions } }));
  const session = spaceSessionFor(LOCAL_SERVER_ID);
  const seam = createRealSeam({
    baseUrl: '',
    wsUrl: 'ws://fake.invalid/v2/ws',
    fetch: f.fetch,
    webSocketFactory: fakeSocketPool().factory,
    timers: clock.timers,
    now: clock.now,
    random: clock.random,
    getAuthToken: () => GATE,
    spaceSession: session,
  });
  return { seam, session };
}

/** `auth.space.enter` goes through `globalThis.fetch`; record what it is asked. */
function stubEnter(): string[] {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    paths.push(new URL(url, 'http://localhost').pathname);
    return new Response(JSON.stringify({
      data: {
        token: 'tm8s_0c0c0c0c-0000-4000-8000-000000000001.pin',
        spaceId: SPACE_A,
        session: {
          sessionId: '0c0c0c0c-0000-4000-8000-000000000001',
          kind: 'browser',
          label: 'tm8 web',
          spaceId: SPACE_A,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return paths;
}

beforeEach(() => {
  installStorage();
  resetSpaceSessions();
  writeServerPass(LOCAL_SERVER_ID, gatePass);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('identity.get advertises spaceSessions — the client reads it', () => {
  it('enforce: marks the server enforcing, and the first space switch mints a pinned session up front', async () => {
    const { seam, session } = seamAdvertising('enforce');
    const entered = stubEnter();
    expect(readSpaceSessionsEnforced(LOCAL_SERVER_ID)).toBe(false);

    await expect(seam.identity()).resolves.toMatchObject({ spaceSessions: 'enforce' });
    expect(readSpaceSessionsEnforced(LOCAL_SERVER_ID)).toBe(true);

    await session.enterSpace(SPACE_A);
    expect(entered).toEqual(['/v2/auth/space/enter']);
  });

  it('agents: pins nothing, and forgets a marker left from an earlier enforce', async () => {
    noteSpaceSessionsEnforced(LOCAL_SERVER_ID);
    const { seam, session } = seamAdvertising('agents');
    const entered = stubEnter();

    await expect(seam.identity()).resolves.toMatchObject({ spaceSessions: 'agents' });
    expect(readSpaceSessionsEnforced(LOCAL_SERVER_ID)).toBe(false);

    await session.enterSpace(SPACE_A);
    expect(entered).toEqual([]);
    expect(session.credentialFor('inbox.list')).toBeNull();
  });

  it('off: pins nothing, like agents', async () => {
    noteSpaceSessionsEnforced(LOCAL_SERVER_ID);
    const { seam, session } = seamAdvertising('off');
    const entered = stubEnter();

    await seam.identity();
    expect(readSpaceSessionsEnforced(LOCAL_SERVER_ID)).toBe(false);
    await session.enterSpace(SPACE_A);
    expect(entered).toEqual([]);
  });

  it('a node that omits the field leaves the marker as it was (the 403 still teaches)', async () => {
    noteSpaceSessionsEnforced(LOCAL_SERVER_ID);
    const { seam } = seamAdvertising(undefined);
    await seam.identity();
    expect(readSpaceSessionsEnforced(LOCAL_SERVER_ID)).toBe(true);
  });
});
