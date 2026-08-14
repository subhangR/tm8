// @vitest-environment jsdom
/**
 * SIGN IN TO THE ACTIVE SERVER, FROM INSIDE THE WORKSPACE.
 *
 * The scenario this guards, verbatim from the field: the viewer is signed in
 * on the local node, switches the rail to a named server (utho-prod) whose
 * node now refuses anonymous callers, and gets… the "Can't reach the tm8
 * node" card, retrying forever. The node was reachable the whole time — it
 * ANSWERED with `unauthenticated` — and the only cure is a sign-in, which
 * nothing on screen offered.
 *
 * What must hold instead, each asserted below:
 *  1. an `unauthenticated` boot read renders the gate's own login frame (1d),
 *     NOT the unreachable-node card;
 *  2. the refusal is not hammered on a timer — the boot loop parks until the
 *     session store changes;
 *  3. signing in through that frame mints a pass against the ACTIVE server
 *     (through the relay path), stores it under the server's ORIGIN, and the
 *     parked boot resumes into the workspace with no reload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import { AuthGate, PASSES_STORAGE_KEY } from '../auth';
import { createFixtureSeam } from '../data';
import type { Seam } from '../data/seam';
import { LOCAL_SERVER, type UiServer } from '../servers';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';

const ACTIVE_SERVER_KEY = 'tm8-ui:active-server';

const STAGING: UiServer = {
  id: 'staging',
  label: 'staging · box',
  baseUrl: 'https://box.example:8888',
  routeBaseUrl: '/v2/server-connections/staging/proxy',
  reachability: 'ok',
};

function installStorage(): void {
  // The gate.test.tsx pattern — LOAD-BEARING under this runner, whose
  // globalThis.localStorage arrives without setItem/removeItem.
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

/**
 * The gate.test.tsx fake auth server, extended with the ONE thing this file
 * is about: the same four routes are also served under the named-server relay
 * prefix (`/v2/server-connections/<name>/proxy/…`), because signing in to the
 * active server rides that path. Which prefix a request used is recorded, so
 * the tests can assert the sign-in went to the SERVER and not to `local`.
 */
function installFakeAuthServer() {
  const server = {
    accounts: new Map<string, { username: string; password: string }>(),
    sessions: new Map<string, string>(),
    requests: [] as Array<{ method: string; path: string }>,
  };
  let minted = 0;

  const accountView = (username: string) => ({
    accountId: `acct_${username}`,
    identityId: `id_${username}`,
    username,
    displayName: username,
    isNodeAdmin: false,
    isOwner: false,
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const refusal = (status: number, code: string, message: string) =>
    json(status, { error: { code, message, requestId: 'req_fake' } });

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const fullPath = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
    server.requests.push({ method, path: fullPath });
    const path = fullPath.replace(/^\/v2\/server-connections\/[^/]+\/proxy(?=\/)/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const bearer = auth.replace(/^Bearer\s+/i, '');

    if (method === 'POST' && path === '/v2/auth/login') {
      const account = server.accounts.get(String(body.username ?? ''));
      if (!account || account.password !== String(body.password ?? '')) {
        return refusal(401, 'unauthenticated', 'invalid credentials');
      }
      minted += 1;
      const sessionId = `sess_${minted}`;
      const token = `tm8s_${sessionId}.secret${minted}`;
      server.sessions.set(token, account.username);
      return json(200, {
        data: {
          token,
          account: accountView(account.username),
          session: {
            sessionId,
            kind: 'browser',
            actingAsTeamMemberId: null,
            label: null,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      });
    }

    if (method === 'GET' && path === '/v2/auth/session') {
      const username = server.sessions.get(bearer);
      if (!username) return refusal(401, 'unauthenticated', 'authentication is required');
      const sessionId = bearer.slice('tm8s_'.length).split('.')[0]!;
      return json(200, {
        data: {
          authKind: 'bearer',
          account: accountView(username),
          session: {
            sessionId,
            kind: 'browser',
            actingAsTeamMemberId: null,
            label: null,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      });
    }

    if (method === 'POST' && path === '/v2/auth/logout') {
      server.sessions.delete(bearer);
      return json(200, { data: { revoked: true } });
    }

    return refusal(500, 'internal_error', `fake auth server: unhandled ${method} ${fullPath}`);
  };

  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: impl });
  return server;
}

/** A signed-in local session, seeded the way `storePass` would have left it. */
function seedLocalSession(server: ReturnType<typeof installFakeAuthServer>): void {
  const token = 'tm8s_sess_local.secretL';
  server.accounts.set('amber', { username: 'amber', password: 'correct-horse' });
  server.sessions.set(token, 'amber');
  localStorage.setItem(ACTIVE_SERVER_KEY, 'local');
  localStorage.setItem(
    PASSES_STORAGE_KEY,
    JSON.stringify({
      [window.location.origin]: {
        token,
        account: {
          handle: 'amber',
          displayName: 'amber',
          accountId: 'acct_amber',
          identityId: 'id_amber',
          isOwner: false,
          isNodeAdmin: false,
        },
        sessionId: 'sess_local',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        signedInAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * The named server's seam: every read is refused `unauthenticated` until this
 * browser holds a pass for it — the same verdict the real node returns — and
 * the fixture data appears once one exists. Call counting is what lets the
 * tests assert the boot loop PARKED instead of hammering the refusal.
 */
function gatedStagingSeam(): { seam: Seam; spacesCalls: () => number } {
  const fixture = createFixtureSeam();
  let calls = 0;
  const seam: Seam = {
    ...fixture,
    spaces: async () => {
      calls += 1;
      const passes = JSON.parse(localStorage.getItem(PASSES_STORAGE_KEY) ?? '{}') as Record<
        string,
        unknown
      >;
      if (!passes[STAGING.baseUrl]) {
        throw new CollabError('unauthenticated', 'authentication is required');
      }
      return fixture.spaces();
    },
  };
  return { seam, spacesCalls: () => calls };
}

let server: ReturnType<typeof installFakeAuthServer>;

beforeEach(() => {
  installStorage();
  server = installFakeAuthServer();
  resetNav();
  /* The URL is state now, and jsdom keeps ONE `window.location` per file. A
     case that navigates leaves its address behind and the next case boots from
     it, because an addressable hash at boot deliberately outranks last-place
     (R3) — so `resetNav()` alone stopped being a reset the day the router was
     mounted. Same class as the localStorage doubles these files already carry,
     one global later. */
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Mount signed-in on local, let boot AND the reload check settle, then
 * switch the active server to staging — the production sequence (App keys
 * GateApp on the server id, and a human switches long after mount). Settling
 * first matters: `verifyStoredSession`'s async refresh re-reads the ACTIVE
 * server, and racing it with the switch would re-decide the gate against a
 * server this browser holds no pass for — a different scenario. */
async function mountAndSwitchToStaging(seam: Seam) {
  seedLocalSession(server);
  const view = render(
    <AuthGate>
      <GateApp key="local" activeServer={LOCAL_SERVER} seam={createFixtureSeam()} />
    </AuthGate>,
  );
  await waitFor(() => expect(screen.getByTestId('workspace-grid')).toBeTruthy());
  localStorage.setItem(ACTIVE_SERVER_KEY, 'staging');
  view.rerender(
    <AuthGate>
      <GateApp key="staging" activeServer={STAGING} seam={seam} />
    </AuthGate>,
  );
  return view;
}

describe('signing in to the active server from inside the workspace', () => {
  it('renders the login frame — not the unreachable-node card — when the server answers unauthenticated', async () => {
    const { seam, spacesCalls } = gatedStagingSeam();
    await mountAndSwitchToStaging(seam);

    const frame = await screen.findByTestId('auth-frame');
    expect(frame.getAttribute('data-frame')).toBe('1d');
    expect(screen.queryByText(/Can’t reach the tm8 node/)).toBeNull();
    // INSIDE the workspace: the rail is still there — this is the in-shell
    // sign-in, not AuthGate's full-screen gate replacing the app.
    expect(screen.getByTestId('menu-rail')).toBeTruthy();

    // The refusal is parked on the session store, not retried on a timer.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spacesCalls()).toBe(1);
  });

  it('signs in through the frame, stores the pass under the server ORIGIN, and boots without a reload', async () => {
    const { seam, spacesCalls } = gatedStagingSeam();
    await mountAndSwitchToStaging(seam);
    await screen.findByTestId('auth-frame');

    fireEvent.change(screen.getByLabelText('HANDLE'), { target: { value: 'amber' } });
    fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    // The frame goes; the parked boot read resumes and the workspace mounts.
    await waitFor(() => expect(screen.queryByTestId('auth-frame')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('workspace-grid')).toBeTruthy());
    expect(spacesCalls()).toBeGreaterThanOrEqual(2);

    // The login rode the RELAY to the named server, not the local node.
    expect(
      server.requests.some(
        (r) =>
          r.method === 'POST' &&
          r.path === '/v2/server-connections/staging/proxy/v2/auth/login',
      ),
    ).toBe(true);

    // And the minted pass is keyed by the server's origin — the origin was
    // noted from the server row in hand, not left to the `name:` fallback.
    const passes = JSON.parse(localStorage.getItem(PASSES_STORAGE_KEY) ?? '{}') as Record<
      string,
      { account: { handle: string } }
    >;
    expect(passes[STAGING.baseUrl]?.account.handle).toBe('amber');
  });

  it('still renders the unreachable-node card for a non-auth boot failure', async () => {
    const fixture = createFixtureSeam();
    const seam: Seam = {
      ...fixture,
      spaces: async () => {
        throw new CollabError('internal_error', 'boom');
      },
    };
    await mountAndSwitchToStaging(seam);

    await screen.findByText(/Can’t reach the tm8 node/);
    expect(screen.queryByTestId('auth-frame')).toBeNull();
  });
});
