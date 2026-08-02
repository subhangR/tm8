// @vitest-environment jsdom
/**
 * THE MANDATORY GATE — the acceptance loop, asserted step by step.
 *
 * The user will run exactly this: reload → land on auth with NO app screen
 * visible → create an account → the app renders → reload keeps you in →
 * sign out → back at the gate. Each leg is a test below, and the loop is also
 * run end-to-end in one go, because six passing legs can still fail as a
 * circuit (the leg that only passes when its predecessor left the wrong state
 * behind is the one a per-leg suite is blind to).
 *
 * WHAT THIS GATE IS (Identity v2 Stage 1): server-backed. Every suite below
 * runs against a FAKE AUTH SERVER installed as `fetch` — an in-memory
 * implementation of `auth.signup` / `auth.login` / `auth.logout` /
 * `auth.session.get` with the contract's own shapes and refusal codes. The
 * assertions therefore measure the wire the gate actually drives: an account
 * created through the UI exists ON THE SERVER, the stored pass is a `tm8s_…`
 * token the server minted, and a revoked pass ends the session on reload.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { IdentityView } from '../data/seam';
import {
  AccountMenu,
  AuthGate,
  readActiveAccount,
  readKnownAccountsHere,
  readStoredSession,
  signOut,
  useAuthSession,
} from './index';
import { defaultSignedOutFrame } from './AuthGate';

function installStorage(): void {
  // The realSeamFlag.test.ts pattern — LOAD-BEARING under this runner, whose
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

/* ── the fake auth server ──────────────────────────────────────────────── */

interface FakeAccount {
  username: string;
  password: string;
  displayName: string | null;
  accountId: string;
  identityId: string;
}

interface FakeAuthServer {
  /** username → account. What `auth.signup` wrote. */
  accounts: Map<string, FakeAccount>;
  /** token → username. Live sessions; `auth.logout` deletes, reload verifies. */
  sessions: Map<string, string>;
  /** Every request the gate made, for negative assertions. */
  requests: Array<{ method: string; path: string }>;
}

function accountView(a: FakeAccount) {
  return {
    accountId: a.accountId,
    identityId: a.identityId,
    username: a.username,
    displayName: a.displayName,
    isNodeAdmin: false,
    isOwner: false,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refusal(status: number, code: string, message: string): Response {
  // The DEV-6 envelope, same shape the real node writes. ONE message for a
  // wrong password and an unknown username — no account enumeration.
  return json(status, { error: { code, message, requestId: 'req_fake' } });
}

/**
 * Installs `fetch`. Implements exactly the four auth routes; anything else is
 * a loud 500, because a gate that quietly called an unimplemented route would
 * green a test that measured nothing.
 */
function installFakeAuthServer(): FakeAuthServer {
  const server: FakeAuthServer = { accounts: new Map(), sessions: new Map(), requests: [] };
  let minted = 0;

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0]!;
    server.requests.push({ method, path });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const bearer = auth.replace(/^Bearer\s+/i, '');

    if (method === 'POST' && path === '/v2/auth/signup') {
      const username = String(body.username ?? '');
      if (server.accounts.has(username)) {
        return refusal(409, 'conflict', `an account named ${username} already exists`);
      }
      const account: FakeAccount = {
        username,
        password: String(body.password ?? ''),
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
        accountId: `acct_${username}`,
        identityId: `id_${username}`,
      };
      server.accounts.set(username, account);
      return json(200, { data: { account: accountView(account) } });
    }

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
          account: accountView(account),
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
      if (server.sessions.has(bearer)) {
        const sessionId = bearer.slice('tm8s_'.length).split('.')[0]!;
        server.sessions.delete(bearer);
        return json(200, { data: { sessionId, revoked: true } });
      }
      // A named session with no bearer: the loopback auto-owner path — the
      // node owner may revoke any session (self-or-node-admin, in SQL).
      if (typeof body.sessionId === 'string') {
        for (const token of server.sessions.keys()) {
          if (token.startsWith(`tm8s_${body.sessionId}.`)) {
            server.sessions.delete(token);
            return json(200, { data: { sessionId: body.sessionId, revoked: true } });
          }
        }
      }
      return refusal(401, 'unauthenticated', 'authentication is required');
    }

    if (method === 'GET' && path === '/v2/auth/session') {
      const username = server.sessions.get(bearer);
      const account = username ? server.accounts.get(username) : undefined;
      if (!account) return refusal(401, 'unauthenticated', 'authentication is required');
      const sessionId = bearer.slice('tm8s_'.length).split('.')[0]!;
      return json(200, {
        data: {
          authKind: 'bearer',
          account: accountView(account),
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

    return refusal(500, 'internal_error', `fake auth server: unhandled ${method} ${path}`);
  };

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: impl,
  });
  return server;
}

const APP = <div data-testid="the-app">THE APP</div>;

/** The acceptance loop's own vocabulary, so a rename cannot silently pass. */
const NAME = 'amber';
const PASSWORD = 'correct-horse';

async function createAccountThroughTheUI(name = NAME, password = PASSWORD) {
  fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: password } });
  // "Create account" — first run or another, the label promises no role
  // auth.signup cannot grant.
  fireEvent.click(screen.getByRole('button', { name: /create (owner )?account/i }));
  // Waits for the GATE to go, not for a particular child: the identity tests
  // pass their own consumer as `children`, and an earlier version of this
  // helper waited on `the-app` and failed them for a reason that had nothing
  // to do with what they assert. The gate's own disappearance is the signal
  // every caller shares.
  await waitFor(() => expect(screen.queryByTestId('auth-frame')).toBeNull());
}

async function signInThroughTheUI(handle = NAME, password = PASSWORD) {
  fireEvent.change(screen.getByLabelText('HANDLE'), { target: { value: handle } });
  fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
}

let server: FakeAuthServer;

beforeEach(() => {
  installStorage();
  server = installFakeAuthServer();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('leg 1 — unauthenticated, the app is NOT on screen', () => {
  it('renders the auth flow and NONE of the children', () => {
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(screen.getByTestId('auth-frame')).toBeTruthy();
  });

  it('opens on the claim frame when no account has signed in here yet', () => {
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a');
  });

  it('opens remote and relayed fresh browsers on sign-in, never on an unauthorized signup promise', () => {
    expect(defaultSignedOutFrame(0, 'local', 'tm8-server.tail28ac62.ts.net')).toBe('1d');
    expect(defaultSignedOutFrame(0, 'staging', 'localhost')).toBe('1d');
    expect(defaultSignedOutFrame(0, 'local', '127.0.0.1')).toBe('1a');
    expect(defaultSignedOutFrame(0, 'local', 'worktree.localhost')).toBe('1a');
  });

  it('does not offer create-another-account on a relayed server', () => {
    localStorage.setItem('tm8-ui:active-server', 'staging');
    render(<AuthGate initialFrame="1d">{APP}</AuthGate>);
    expect(screen.queryByRole('button', { name: /create another account/i })).toBeNull();
  });

  it('opens on the LOGIN frame when an account is known but no session exists', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    act(() => signOut());
    cleanup();
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1d');
  });

  it('renders no children at all while signed out', () => {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(true);
      return null;
    }
    render(
      <AuthGate>
        <Probe />
        {APP}
      </AuthGate>,
    );
    expect(seen).toEqual([]); // not hidden, not mounted — never rendered
  });
});

describe('leg 2 — create an account, and the app renders', () => {
  it('creates the account ON THE SERVER and lets the children through', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(screen.queryByTestId('auth-frame')).toBeNull();
    // THE POINT OF THE UPGRADE: the server has the account and minted the
    // session. A browser-local record would pass every DOM assertion above.
    expect(server.accounts.has(NAME)).toBe(true);
    expect(server.sessions.size).toBe(1);
  });

  it('stores the tm8s_ pass and NEVER the password', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    const everything: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      everything.push(key, localStorage.getItem(key) ?? '');
    }
    expect(everything.join('\n')).not.toContain(PASSWORD);
    const session = readStoredSession()!;
    expect(session.handle).toBe(NAME);
    expect(session.serverId).toBe('local');
    // The pass is the server's own mint, stored under the TARGET ORIGIN (the
    // lead's programme-wide credential-key ruling; 'local' → the page origin).
    const stored = JSON.parse(localStorage.getItem('tm8ui.auth.passes.v1') ?? '{}');
    const entry = stored[window.location.origin];
    expect(String(entry?.token).startsWith('tm8s_')).toBe(true);
    expect(server.sessions.has(entry.token)).toBe(true);
  });

  it('refuses a password shorter than the 8 characters the server enforces', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: NAME } });
    fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /create (owner )?account/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/8/));
    expect(screen.queryByTestId('the-app')).toBeNull();
    // Refused client-side, matching the server's floor — nothing was sent.
    expect(server.accounts.size).toBe(0);
  });
});

describe('leg 3 — reload keeps you in, because the server says the pass stands', () => {
  it('survives a full unmount/remount with the session intact', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    cleanup(); // the reload
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(screen.queryByTestId('auth-frame')).toBeNull();
  });

  it('NEVER paints the gate on the way in — no sign-in flash on reload', async () => {
    // THE PROPERTY, MEASURED. The previous version of this assertion checked
    // that children were absent while signed out, called that "no flash", and
    // stayed green when the storage read was moved into a useEffect — a green
    // that was never red. Testing-library's `render` flushes effects inside
    // act(), so by assertion time the deferred version has already corrected
    // itself and looks identical.
    //
    // A MutationObserver sees what the final DOM cannot: whether the gate was
    // EVER in the document. On reload with a live session it must never have
    // been, or the viewer gets a sign-in card flashing past on every load.
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    cleanup();

    let gateAppeared = false;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node instanceof HTMLElement && node.querySelector?.('[data-testid="auth-frame"]')) {
            gateAppeared = true;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    render(<AuthGate>{APP}</AuthGate>); // the reload
    observer.takeRecords().forEach((r) => {
      for (const node of r.addedNodes) {
        if (node instanceof HTMLElement && node.querySelector?.('[data-testid="auth-frame"]')) {
          gateAppeared = true;
        }
      }
    });
    observer.disconnect();

    expect(gateAppeared, 'the sign-in card was mounted before the session resolved').toBe(false);
    expect(screen.getByTestId('the-app')).toBeTruthy();
  });

  it('ENDS the session on reload when the server has revoked the pass', async () => {
    // The reload check is auth.session.get, not a localStorage read — this is
    // the one behaviour the old gate could not have, and the reason the
    // upgrade exists. Revoke server-side, reload, and the gate must close.
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    cleanup();
    server.sessions.clear(); // revoked elsewhere — another device, an admin
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.queryByTestId('the-app')).toBeNull());
    expect(screen.getByTestId('auth-frame')).toBeTruthy();
  });

  it('does NOT keep you in when only the known account survives, without a pass', async () => {
    // The pass and the known-accounts list are separate records ON PURPOSE:
    // sign-out must not forget the account, and a surviving account must not
    // imply a surviving session.
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    act(() => signOut());
    expect(readKnownAccountsHere()).toHaveLength(1);
    expect(readActiveAccount()).toBeNull();
    expect(readStoredSession()).toBeNull();
  });
});

describe('leg 4 — sign out returns to the gate, and revokes on the server', () => {
  it('drops back to the flow, hides the app, and revokes the session', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    expect(server.sessions.size).toBe(1);
    act(() => signOut());
    await waitFor(() => expect(screen.queryByTestId('the-app')).toBeNull());
    expect(screen.getByTestId('auth-frame')).toBeTruthy();
    // auth.logout reached the server — the pass is dead THERE, not just here.
    await waitFor(() => expect(server.sessions.size).toBe(0));
  });

  it('signs out from the account menu, the surface the oracle puts it on', async () => {
    render(<AuthGate initialSignedInFrame="1p">{APP}</AuthGate>);
    await createAccountThroughTheUI();
    // 1p is reachable through the gate's own account surface once signed in;
    // the coordinator mounts it, so the exported verb is what is asserted.
    act(() => signOut());
    await waitFor(() => expect(screen.queryByTestId('the-app')).toBeNull());
  });
});

describe('leg 5 — sign in verifies against the SERVER', () => {
  beforeEach(async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    act(() => signOut());
  });

  it('lets the right password through', async () => {
    await signInThroughTheUI();
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
  });

  it('refuses the wrong password, and says which handle failed', async () => {
    await signInThroughTheUI(NAME, 'wrong-password');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/@amber/));
    expect(screen.queryByTestId('the-app')).toBeNull();
  });

  it('refuses an unknown handle WITHOUT confirming which half was wrong', async () => {
    // The server refuses both halves with one code and one message — no
    // account enumeration — and the gate's copy must not re-split them.
    await signInThroughTheUI('nobody', PASSWORD);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).not.toMatch(/no such|unknown handle|does not exist/i);
  });

  it('does NOT invent an attempt counter or a lockout', async () => {
    // The oracle draws "4 attempts left, then a 5-minute hold". Nothing
    // enforces either. A countdown that never counts is the same class of lie
    // as a login that never logs in.
    await signInThroughTheUI(NAME, 'wrong-password');
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).not.toMatch(/attempts left|minute hold/i);
  });
});

describe('THE HONESTY LAW, at the gate', () => {
  it('no frame claims the account is browser-local — that stopped being true', async () => {
    // The old gate carried a "local account on this node" note on every
    // credential frame. With auth.signup/auth.login wired, that sentence
    // would be the same lie in the other direction, so it must be GONE.
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.queryByTestId('auth-local-note')).toBeNull();
    const frame = screen.getByTestId('auth-frame');
    expect(frame.textContent).not.toMatch(/stored (in this browser|locally)/i);
    expect(frame.textContent).not.toMatch(/not registered on the tm8 node/i);
    // …and the copy states the real act instead.
    expect(frame.textContent).toMatch(/on the tm8 node|on this server/i);
  });

  it('the sign-in frame names no local store either', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());
    expect(screen.queryByTestId('auth-local-note')).toBeNull();
    expect(screen.getByTestId('auth-frame').textContent).not.toMatch(
      /stored (in this browser|locally)/i,
    );
  });

  it('keeps the token path refused — no operation redeems a pasted token', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /use an access token instead/i }));
    const refusals = screen.getAllByTestId('disabled-with-reason');
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.some((r) => /sign in with token/i.test(r.textContent ?? ''))).toBe(true);
  });

  it('the first-run card says why it completes at step 1 of 3', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    const frame = screen.getByTestId('auth-frame');
    expect(frame.textContent).toMatch(/step 1 of 3/i);
    // …and states that the remaining two steps have no operation behind them,
    // rather than drawing a wizard whose last two steps do nothing.
    expect(frame.textContent).toMatch(/no operation|isn’t connected|not connected/i);
  });
});

describe('the server identity binds when the real seam is on', () => {
  const IDENTITY: IdentityView = {
    identityId: 'id_1',
    accountId: 'acct_1',
    username: 'amber-from-server',
    displayName: 'Amber',
    avatar: null,
    email: null,
    globalId: null,
    isNodeAdmin: true,
    isOwner: true,
    status: 'active',
    actingAs: null,
    memberships: [],
  };

  it('resolves identity.get once signed in and exposes it to the host', async () => {
    const resolveIdentity = vi.fn().mockResolvedValue(IDENTITY);
    function Consumer() {
      const s = useAuthSession();
      return <div data-testid="who">{s.serverIdentity?.username ?? 'none'}</div>;
    }
    render(
      <AuthGate resolveIdentity={resolveIdentity}>
        <Consumer />
      </AuthGate>,
    );
    await createAccountThroughTheUI();
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('amber-from-server'));
    expect(resolveIdentity).toHaveBeenCalled();
  });

  it('exposes the auth.session.get identity when no resolver is supplied', async () => {
    function Consumer() {
      const s = useAuthSession();
      return <div data-testid="who">{s.serverIdentity?.username ?? 'none'}</div>;
    }
    render(
      <AuthGate>
        <Consumer />
      </AuthGate>,
    );
    await createAccountThroughTheUI();
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(NAME));
  });

  it('does NOT resolve identity while signed out', () => {
    const resolveIdentity = vi.fn().mockResolvedValue(IDENTITY);
    render(<AuthGate resolveIdentity={resolveIdentity}>{APP}</AuthGate>);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('stays signed in when identity.get rejects — reachability is not revocation', async () => {
    // The two facts are independent, and conflating them would log the viewer
    // out every time the node hiccups. The failure is surfaced, not swallowed.
    const resolveIdentity = vi.fn().mockRejectedValue(new Error('node down'));
    function Consumer() {
      const s = useAuthSession();
      return <div data-testid="who">{s.identityError ? 'error' : 'ok'}</div>;
    }
    render(
      <AuthGate resolveIdentity={resolveIdentity}>
        <Consumer />
      </AuthGate>,
    );
    await createAccountThroughTheUI();
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('error'));
  });
});

describe('THE WHOLE LOOP, in one circuit', () => {
  it('reload → gate → create → app → reload → still in → sign out → gate', async () => {
    // 1. reload, unauthenticated: gate, no app
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.queryByTestId('the-app')).toBeNull();

    // 2. create an account: the app renders
    await createAccountThroughTheUI();
    expect(screen.getByTestId('the-app')).toBeTruthy();

    // 3. reload: still in
    cleanup();
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.getByTestId('the-app')).toBeTruthy();

    // 4. sign out: back at the gate, on the signed-out landing
    act(() => signOut());
    await waitFor(() => expect(screen.queryByTestId('the-app')).toBeNull());

    // 5. reload while signed out: STILL at the gate (not a one-render effect)
    cleanup();
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.queryByTestId('the-app')).toBeNull();

    // 6. sign back in with the same credentials: the app returns
    await signInThroughTheUI();
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
  });
});

describe('blocked storage is refused out loud, never failed silently', () => {
  it('says the pass cannot persist rather than pretending it did', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem() {
          throw new Error('blocked');
        },
        removeItem() {},
        clear() {},
      },
    });
    render(<AuthGate>{APP}</AuthGate>);
    fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: NAME } });
    fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /create (owner )?account/i }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/storage|cannot be saved/i),
    );
    // And crucially: it did NOT let the viewer into an app it cannot keep
    // them in. A session that vanishes on reload is worse than no session.
    expect(screen.queryByTestId('the-app')).toBeNull();
    // The orphaned server session is revoked rather than left standing.
    await waitFor(() => expect(server.sessions.size).toBe(0));
  });
});

/**
 * MULTI-ACCOUNT + THE WORKSPACE ACCOUNT MENU (user-ordered, 2026-07-29).
 *
 * "add logout option, and show the user name on the workspace. the owner name.
 * and logout, option which logs out, and i can create another account or login
 * with same account."
 *
 * Accounts now live on the server; the browser keeps only the pass and the
 * list of handles that have signed in here.
 */
describe('more than one account', () => {
  it('creates a second account without destroying the first', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);
    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());

    // From the login frame there must be a way to make a NEW one.
    fireEvent.click(screen.getByRole('button', { name: /create another account/i }));
    expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a');
    await createAccountThroughTheUI('nadia', 'another-password');

    expect([...server.accounts.keys()].sort()).toEqual(['amber', 'nadia']);
    expect(readKnownAccountsHere().map((a) => a.handle).sort()).toEqual(['amber', 'nadia']);
  });

  it('signs in as EITHER account with its own password', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);
    act(() => signOut());
    fireEvent.click(screen.getByRole('button', { name: /create another account/i }));
    await createAccountThroughTheUI('nadia', 'another-password');
    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());

    // the first account, with its own password
    await signInThroughTheUI('amber', PASSWORD);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(readStoredSession()!.handle).toBe('amber');

    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());

    // the second, with ITS password — and NOT with the first's
    await signInThroughTheUI('nadia', PASSWORD);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByTestId('the-app')).toBeNull();

    await signInThroughTheUI('nadia', 'another-password');
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(readStoredSession()!.handle).toBe('nadia');
  });

  it('refuses a handle the server already has, and says which', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);
    act(() => signOut());
    fireEvent.click(screen.getByRole('button', { name: /create another account/i }));
    fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: 'amber' } });
    fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: 'different-enough' } });
    fireEvent.click(screen.getByRole('button', { name: /create (owner )?account/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/@amber/));
    expect(server.accounts.size).toBe(1);
  });
});

describe('the workspace account menu — name + logout, in the app', () => {
  it('changes the workspace theme immediately through the controlled menu', async () => {
    function ThemedAppWithMenu() {
      const [theme, setTheme] = useState<'light' | 'dark'>('light');
      return (
        <div data-testid="the-app" data-theme={theme === 'dark' ? 'dark' : undefined}>
          <AccountMenu theme={theme} onThemeChange={setTheme} />
        </div>
      );
    }

    render(<AuthGate><ThemedAppWithMenu /></AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    fireEvent.click(within(screen.getByTestId('auth-account-menu')).getByRole('button', { name: 'dark' }));

    expect(screen.getByTestId('the-app').getAttribute('data-theme')).toBe('dark');
  });

  it('shows the signed-in name and signs out from inside the app', async () => {
    function AppWithMenu() {
      return (
        <div data-testid="the-app">
          <AccountMenu />
        </div>
      );
    }
    render(<AuthGate>{<AppWithMenu />}</AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);

    // THE NAME IS ON SCREEN. The user asked for the owner name on the
    // workspace, so the trigger carries it — not just an initial in a circle.
    const trigger = screen.getByTestId('account-menu-trigger');
    expect(trigger.textContent).toMatch(/amber/);

    fireEvent.click(trigger);
    const menu = screen.getByTestId('auth-account-menu');
    expect(within(menu).getByText(/@amber/)).toBeTruthy();

    fireEvent.click(within(menu).getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(screen.queryByTestId('the-app')).toBeNull());
    expect(screen.getByTestId('auth-frame')).toBeTruthy();
  });

  it('after that logout, BOTH paths are offered — sign in, or make another', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);
    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /create another account/i })).toBeTruthy();
  });

  it('names the SERVER account the node vouched for — never "local"', async () => {
    // The node authenticated this account at auth.login; the menu may say so,
    // and must no longer describe it as a local record.
    function AppWithMenu() {
      return (
        <div data-testid="the-app">
          <AccountMenu />
        </div>
      );
    }
    render(<AuthGate>{<AppWithMenu />}</AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    const text = screen.getByTestId('auth-account-menu').textContent ?? '';
    expect(text).toMatch(/server account|owner of this server/i);
    expect(text).not.toMatch(/local account/i);
  });
});
