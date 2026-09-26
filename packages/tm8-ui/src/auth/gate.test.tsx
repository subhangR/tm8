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
  AuthFlow,
  AuthGate,
  readActiveAccount,
  readKnownAccountsHere,
  readStoredSession,
  signOut,
  useAuthSession,
} from './index';
import { defaultSignedOutFrame } from './AuthGate';
import { InvitesPanel } from '../settings-space/InviteFrames';
import {
  AUTO_OWNER_CACHE_KEY,
  NODE_CLAIM_CACHE_KEY,
  isAutoOwnerSuppressed,
} from './session';

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
  /** The node owner — the account the claim credentialed. */
  isOwner?: boolean;
}

interface FakeAuthServer {
  /** username → account. What `auth.signup` wrote. */
  accounts: Map<string, FakeAccount>;
  /** token → username. Live sessions; `auth.logout` deletes, reload verifies. */
  sessions: Map<string, string>;
  /** Every request the gate made, for negative assertions. */
  requests: Array<{ method: string; path: string }>;
  /**
   * The node's live claim token, or null once burned. A node is CLAIMED when
   * any account exists — the same rule `public.node_is_claimed()` applies, so
   * the fake and the real server agree on the one fact the gate branches on.
   */
  claimToken: string | null;
  /**
   * The loopback auto-owner this node resolves a CREDENTIAL-FREE caller to, or
   * null when the arm is off (`multi` mode, or a remote origin). Mirrors the
   * real `auth.session.get`: with no bearer and this set, the node answers
   * `authKind: 'auto-owner'` with a null session; with it null it answers
   * `unauthenticated`. Off by default so every existing suite is unaffected.
   */
  autoOwner: FakeAccount | null;
  /**
   * The node mode as `auth.claim.status` reports it (doc 20 §3.4). Defaults to
   * a RECORDED personal node so every suite that predates node modes goes
   * straight to the app after a claim; the chooser tests clear `modeSet`.
   */
  mode: 'personal' | 'peer' | 'server';
  modeSet: boolean;
  modeSource: 'env' | 'file' | 'default';
  /** The mode this process booted with — what `restartRequired` compares against. */
  runningMode: 'personal' | 'peer' | 'server';
}

/** What the boot log would have printed. */
export const FAKE_CLAIM_TOKEN = 'tm8c_test-claim-token';

function accountView(a: FakeAccount) {
  return {
    accountId: a.accountId,
    identityId: a.identityId,
    username: a.username,
    displayName: a.displayName,
    isNodeAdmin: false,
    isOwner: a.isOwner === true,
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
  const server: FakeAuthServer = {
    accounts: new Map(),
    sessions: new Map(),
    requests: [],
    claimToken: FAKE_CLAIM_TOKEN,
    autoOwner: null,
    mode: 'personal',
    modeSet: true,
    modeSource: 'file',
    runningMode: 'personal',
  };
  let minted = 0;

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0]!;
    server.requests.push({ method, path });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const bearer = auth.replace(/^Bearer\s+/i, '');

    // `auth.claim.status` — claim-free, and the gate asks it before it can
    // know who anybody is. Claimed === any account exists.
    if (method === 'GET' && path === '/v2/auth/claim') {
      const claimed = server.accounts.size > 0;
      return json(200, {
        data: {
          claimed,
          mode: server.mode,
          modeSet: server.modeSet,
          modeSource: server.modeSource,
          signupPath: claimed ? 'admin' : 'claim',
        },
      });
    }

    // `auth.claim` — the token is the authorization. Single-use: burned here,
    // so a second claim with the same token is refused exactly as the real
    // `claim_node` refuses it.
    if (method === 'POST' && path === '/v2/auth/claim') {
      if (!server.claimToken || String(body.token ?? '') !== server.claimToken) {
        return refusal(401, 'unauthenticated', 'invalid or already-used claim token');
      }
      if (server.accounts.size > 0) {
        return refusal(403, 'forbidden', 'this node is already claimed');
      }
      server.claimToken = null;
      const username = String(body.username ?? '');
      const account: FakeAccount = {
        username,
        password: String(body.password ?? ''),
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
        accountId: `acct_${username}`,
        identityId: `id_${username}`,
        isOwner: true,
      };
      server.accounts.set(username, account);
      // MUST follow the login route's token shape: the logout route resolves a
      // named session by `token.startsWith('tm8s_' + sessionId + '.')`, so a
      // claim-minted token in any other shape is unrevokable — which showed up
      // as the blocked-storage test finding an orphaned session it could not
      // clean up.
      minted += 1;
      const sessionId = `sess_${minted}`;
      const token = `tm8s_${sessionId}.secret${minted}`;
      server.sessions.set(token, username);
      return json(200, {
        data: {
          token,
          account: accountView(account),
          session: {
            sessionId,
            kind: 'browser',
            actingAsTeamMemberId: null,
            label: 'first-run claim',
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      });
    }

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
      if (!account) {
        // No bearer. On a loopback single-player node the server resolves the
        // credential-free caller as the auto-owner (no session row); with the
        // arm off it refuses, and the gate shows sign-in.
        if (server.autoOwner) {
          return json(200, {
            data: {
              authKind: 'auto-owner',
              account: { ...accountView(server.autoOwner), isOwner: true, isNodeAdmin: true },
              session: null,
            },
          });
        }
        return refusal(401, 'unauthenticated', 'authentication is required');
      }
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

    // `node.mode.set`, in the real handler's order (doc 20 §2 as amended by
    // decision 34): anonymous, pinned, UNCLAIMED FOR EVERY MODE, then owner.
    if (method === 'PUT' && path === '/v2/node/mode') {
      const username = server.sessions.get(bearer);
      const caller = username ? server.accounts.get(username) : server.autoOwner;
      if (!caller) return refusal(401, 'unauthenticated', 'authentication is required');
      if (server.modeSource === 'env') return refusal(409, 'conflict', 'the node mode is pinned by TM8_NODE_MODE');
      if (server.accounts.size === 0) {
        return refusal(409, 'conflict', 'choosing a node mode needs an owner password: claim the node first');
      }
      if (username && !caller.isOwner) return refusal(403, 'forbidden', 'only the node owner may change the node mode');
      const mode = String(body.mode) as FakeAuthServer['mode'];
      // The auto-owner may tighten, never loosen (doc 20 §2).
      const rank = (m: string) => ['personal', 'peer', 'server'].indexOf(m);
      if (!username && rank(mode) < rank(server.mode)) {
        return refusal(403, 'forbidden', 'loosening the node mode needs the owner\u2019s password session');
      }
      const previous = server.mode;
      Object.assign(server, { mode, modeSet: true, modeSource: 'file' });
      const restartRequired = (server.runningMode === 'server') !== (mode === 'server');
      return json(200, { data: { previous, mode, source: 'file', restartRequired } });
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
const DISPLAY_ACTOR = {
  id: 'm-amber',
  kind: 'member' as const,
  displayName: 'amber',
  isAgent: false,
};

async function createAccountThroughTheUI(name = NAME, password = PASSWORD) {
  // On an unclaimed node the first-run card performs `auth.claim`, and the
  // token is the authorization. Filled only when the field is on screen so
  // this helper still drives the plain signup card where that is what renders.
  const tokenField = screen.queryByLabelText('SETUP TOKEN');
  if (tokenField) {
    fireEvent.change(tokenField, { target: { value: FAKE_CLAIM_TOKEN } });
  }
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
  // A WARM BROWSER — one that has seen this node before. The gate reads the
  // per-server claim cache synchronously so the first paint is already
  // correct; without this seed every test below would be measuring the cold
  // round trip rather than the auth loop it is actually about. The cold path
  // has its own tests ("a cold browser…" below), which is where that
  // behaviour belongs.
  localStorage.setItem(
    NODE_CLAIM_CACHE_KEY,
    JSON.stringify({ local: { claimed: false, mode: 'personal', modeSet: true, modeSource: 'file', signupPath: 'claim' } }),
  );
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


  /**
   * THIS TEST USED TO ASSERT THE DEAD END. Its previous form pinned
   * `defaultSignedOutFrame(0, 'local', 'tm8-server.tail…')` to `1d` — a remote
   * fresh browser was sent to a sign-in card for a node that had no credential
   * and no way to get one. That was honest about `auth.signup` being refused
   * and silent about there being no way forward at all.
   *
   * The frame now follows the NODE, not the hostname: an unclaimed node offers
   * the claim card wherever the browser is, because the claim token authorizes
   * the act without loopback.
   */
  it('follows the node, not the hostname — an unclaimed node offers the claim card anywhere', () => {
    // Every mode, and a mode not yet chosen: unclaimed is ALWAYS the claim card
    // (decision 34 — the chooser comes after the claim, never instead of it).
    for (const mode of ['personal', 'peer', 'server'] as const) {
      for (const modeSet of [true, false]) {
        expect(defaultSignedOutFrame({ claimed: false, mode, modeSet, signupPath: 'claim' })).toBe('1a');
        expect(defaultSignedOutFrame({ claimed: true, mode, modeSet, signupPath: 'admin' })).toBe('1d');
      }
    }
  });

  /**
   * An unreachable node is NOT an unclaimed one. Rendering the claim ceremony
   * for a node that never answered would promise an act that cannot succeed —
   * the same class of lie the old hostname rule told, pointed the other way.
   */
  it('never reads an unanswered node as unclaimed', () => {
    expect(defaultSignedOutFrame(null)).toBe('1d');
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

/**
 * THE LOOPBACK AUTO-OWNER — the owner on the node's own machine gets no gate.
 *
 * FIRST-RUN-CLAIM-DESIGN D3 / journey §5.1 step 3, verbatim: "Day to day on the
 * box: localhost:8888 → loopback → no gate, straight into the app." The server
 * already resolves a credential-free loopback caller as the owner
 * (`auth.session.get` → `authKind: 'auto-owner'`, null session). These suites
 * are the gate finally ASKING — the completion of §4.2's lane, which fixed
 * WHICH card to show and left WHETHER to show one to a browser-local read.
 *
 * The fake's `autoOwner` arm is the node's `TM8_NODE_MODE=single` behaviour:
 * set, it answers auto-owner to a bare `auth.session.get`; null, it refuses
 * exactly as `multi` mode does. Every assertion here is therefore driven by the
 * SERVER'S answer, never by a browser inference about loopback.
 */
const OWNER_ACCOUNT = {
  username: 'owner',
  password: '',
  displayName: 'The Owner',
  accountId: 'acct_owner',
  identityId: 'id_owner',
};

/** The GateAccount shape the auto-owner cache holds, for warm-browser tests. */
const OWNER_CACHED = {
  handle: 'owner',
  displayName: 'The Owner',
  accountId: 'acct_owner',
  identityId: 'id_owner',
  isOwner: true,
  isNodeAdmin: true,
};

describe('the loopback auto-owner — no gate on the box, the whole point of D3', () => {
  it('signs the owner straight into the app on a cold browser — and NO card ever flashes', async () => {
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY); // a genuinely COLD browser
    server.autoOwner = { ...OWNER_ACCOUNT };
    // The node is CLAIMED — the daily-win scenario. Auto-owner is a sign-in only
    // on a claimed node; on an unclaimed one the claim ceremony must win instead
    // (see the regression test below), so the owner account is present here.
    server.accounts.set('owner', { ...OWNER_ACCOUNT, password: PASSWORD });

    // The reload no-flash proof, pointed at first-run: the gate must never have
    // been mounted on the way in. A password prompt for an account that needs
    // none is the exact false promise this lane removes.
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
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    observer.takeRecords().forEach((r) => {
      for (const node of r.addedNodes) {
        if (node instanceof HTMLElement && node.querySelector?.('[data-testid="auth-frame"]')) {
          gateAppeared = true;
        }
      }
    });
    observer.disconnect();

    expect(gateAppeared, 'a password card flashed before the app on the owner’s own machine').toBe(false);
    expect(screen.queryByTestId('auth-frame')).toBeNull();
  });

  it('a warm browser that has been here renders the app on the FIRST paint, no round trip', () => {
    localStorage.setItem(AUTO_OWNER_CACHE_KEY, JSON.stringify({ local: OWNER_CACHED }));
    server.autoOwner = { ...OWNER_ACCOUNT };
    render(<AuthGate>{APP}</AuthGate>);
    // Synchronous — the no-flash mechanism the stored pass uses, extended to the
    // auto-owner arm. No `waitFor`: if this needed a round trip it would flash.
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(screen.queryByTestId('auth-frame')).toBeNull();
  });

  it('refuses until claimed — a PERSONAL node included (decision 34), and never sets a mode', async () => {
    // THE REGRESSION. On first run the server resolves the credential-free
    // loopback caller as the auto-owner (that is HOW the owner row is minted),
    // and `auth.claim.status` still answers `claimed: false`. Signing the viewer
    // straight into the app here buries the claim ceremony: the node never gets
    // a password, and the first off-box login over the tailnet meets a sign-in
    // card with no credential behind it — §1's dead end, restored by a different
    // route. The claim card must win while `claimed` is false.
    //
    // DECISION 34 (the lead's default C, 2026-09-26) keeps this for PERSONAL
    // too. Doc 20 had planned "signs in on an unclaimed personal node"; that is
    // exactly the arm the advisor removed — under the launch cookie (#847) a local
    // agent is never the owner, so the owner claims once with a password first.
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY); // cold: no cached claim to paint from
    Object.assign(server, { mode: 'personal', modeSet: false, modeSource: 'default' }); // first run
    server.autoOwner = { ...OWNER_ACCOUNT }; // the server WOULD resolve auto-owner…
    // …but no account exists yet, so the fake answers `auth.claim.status` with
    // `claimed: false` — a genuinely unclaimed node.
    expect(server.accounts.size).toBe(0);
    render(<AuthGate>{APP}</AuthGate>);
    // The CLAIM card (frame 1a), not the app, and not a silent sign-in.
    await waitFor(() =>
      expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'),
    );
    expect(screen.queryByTestId('the-app')).toBeNull();
    // And the app never rendered on the way there — the loopback probe held the
    // blank until the claim answer was known, so no app frame flashed first.
    expect(screen.queryByTestId('the-app')).toBeNull();
    // The setup token is reachable on that card — the escape the whole lane exists
    // to keep open — so the owner can complete the claim from here.
    expect(screen.getByLabelText('SETUP TOKEN')).toBeTruthy();
    // No chooser before the claim, and nothing asked the node to record a mode.
    expect(server.requests.some((r) => r.path === '/v2/node/mode')).toBe(false);
  });

  it('the paired positive: claimed PERSONAL + launch cookie → the owner is auto-signed in', async () => {
    // The fake's `autoOwner` stands for the server's answer to a caller holding
    // the `__Host-tm8-launch` cookie (#847): the cookie is a server-side fact the
    // browser cannot read, so the gate's whole contribution is to ask.
    // The mirror of the regression above: once the node is claimed, the very
    // same loopback caller signs straight in with no gate. Auto-owner is gated
    // ON the claim, not weakened by it.
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY);
    server.autoOwner = { ...OWNER_ACCOUNT };
    server.accounts.set('owner', { ...OWNER_ACCOUNT, password: PASSWORD }); // claimed now
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(screen.queryByTestId('auth-frame')).toBeNull();
  });

  it('does NOT render an UNREACHABLE node as auto-owner — the mirror of an unclaimed one', async () => {
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY);
    // The node is down: every call rejects. Rendering it as auto-owner would
    // promise an app that cannot load, exactly the lie the claim path refuses
    // when it declines to offer a ceremony to an unreachable node.
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1d');
  });

  it('keeps the gate in MULTI mode — driven by the server’s refusal, not the browser', async () => {
    // autoOwner stays null: the node refuses a credential-free caller, which is
    // precisely what TM8_NODE_MODE=multi does server-side. A claimed node makes
    // the honest card sign-in.
    localStorage.setItem(
      NODE_CLAIM_CACHE_KEY,
      JSON.stringify({ local: { claimed: true, mode: 'server', modeSet: true, modeSource: 'env', signupPath: 'invite' } }),
    );
    server.accounts.set('amber', {
      username: 'amber',
      password: PASSWORD,
      displayName: 'amber',
      accountId: 'acct_amber',
      identityId: 'id_amber',
    });
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() =>
      expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1d'),
    );
    expect(screen.queryByTestId('the-app')).toBeNull();
  });

  it('does NOT probe the loopback arm on a named server — it can never be the loopback peer', async () => {
    localStorage.setItem('tm8-ui:active-server', 'staging');
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY);
    server.autoOwner = { ...OWNER_ACCOUNT }; // even if the fake would answer, a named server must not ask
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(server.requests.some((r) => r.path === '/v2/auth/session')).toBe(false);
  });

  it('sign-out RETURNS to the gate and does NOT instantly sign you back in', async () => {
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY);
    server.autoOwner = { ...OWNER_ACCOUNT };
    server.accounts.set('owner', { ...OWNER_ACCOUNT, password: PASSWORD }); // claimed node
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());

    act(() => signOut());

    // The gate comes back and STAYS — the "signed out on purpose" flag stops
    // the very next loopback resolution from undoing the act. Without it,
    // sign-out is a no-op on the one machine it matters most.
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(isAutoOwnerSuppressed()).toBe(true);
  });

  it('signing back in after that sign-out lifts the opt-out and lands back in the app', async () => {
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY);
    server.autoOwner = { ...OWNER_ACCOUNT };
    server.accounts.set('owner', { ...OWNER_ACCOUNT, password: PASSWORD }); // claimed node
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());

    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());
    expect(isAutoOwnerSuppressed()).toBe(true);

    // The deliberate sign-IN is the one act that says "resume me here", and it
    // clears the opt-out — through `storePass`, the SAME path a claim takes, so
    // a claim on an unclaimed node lifts it identically. On this claimed node the
    // honest card is the sign-in card, so the owner signs back in by password.
    signInThroughTheUI('owner', PASSWORD);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(isAutoOwnerSuppressed()).toBe(false);
  });
});

/**
 * THE FIRST-RUN CHOOSER, AFTER THE CLAIM (doc 20 §5, as amended by decision 34).
 * The node answers `modeSet: false`; the claim runs first; then the owner —
 * signed in by the claim — is asked Personal, Peer or Server.
 */
describe('the node-mode chooser — after the claim, owner only', () => {
  beforeEach(() => {
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY);
    Object.assign(server, { mode: 'personal', modeSet: false, modeSource: 'default' });
  });

  async function claimToChooser() {
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'));
    fireEvent.change(screen.getByLabelText('SETUP TOKEN'), { target: { value: FAKE_CLAIM_TOKEN } });
    fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: NAME } });
    fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /create (owner )?account/i }));
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1s'));
    expect(screen.queryByTestId('the-app')).toBeNull();
  }

  it('claim first, then the chooser; "Just me" records personal with the claim\u2019s pass and opens the app', async () => {
    await claimToChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Just me' }));
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(server).toMatchObject({ mode: 'personal', modeSet: true, modeSource: 'file' });
    // The order is the decision: the claim reached the node before any mode did.
    const paths = server.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths.indexOf('POST /v2/auth/claim')).toBeLessThan(paths.indexOf('PUT /v2/node/mode'));
  });

  it('"A shared server" needs a restart: 1r says so, and Continue lands in the app', async () => {
    await claimToChooser();
    fireEvent.click(screen.getByRole('button', { name: 'A shared server' }));
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1r'));
    expect(server.mode).toBe('server');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
  });

  it('"Me and a few others" records peer with no restart (the arm does not move)', async () => {
    await claimToChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Me and a few others' }));
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(server.mode).toBe('peer');
  });

  it('a PINNED node never asks — no operation can move it', async () => {
    server.modeSource = 'env';
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'));
    await createAccountThroughTheUI();
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(server.requests.some((r) => r.path === '/v2/node/mode')).toBe(false);
  });

  it('a signed-in NON-owner on a mode-less node gets the app, not the chooser', async () => {
    server.accounts.set('amber', { username: 'amber', password: PASSWORD, displayName: 'amber', accountId: 'acct_amber', identityId: 'id_amber' });
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1d'));
    signInThroughTheUI('amber', PASSWORD);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
  });

  it('choosing Personal lifts a sign-out suppression — "just me" means the cookie may sign me in', async () => {
    localStorage.setItem('tm8ui.auth.autoowner-suppressed.v1', JSON.stringify({ local: true }));
    server.accounts.set('owner', { ...OWNER_ACCOUNT, password: PASSWORD, isOwner: true });
    render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1d'));
    // A deliberate sign-in lifts it too (`storePass`); re-suppress to isolate the chooser's own act.
    signInThroughTheUI('owner', PASSWORD);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1s'));
    localStorage.setItem('tm8ui.auth.autoowner-suppressed.v1', JSON.stringify({ local: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Just me' }));
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(isAutoOwnerSuppressed()).toBe(false);
  });

  it('the node refusing is shown on the chooser, which stays up', async () => {
    await claimToChooser();
    server.modeSource = 'env'; // pinned between the status read and the click
    fireEvent.click(screen.getByRole('button', { name: 'Just me' }));
    await waitFor(() => expect(screen.getByText(/pinned by TM8_NODE_MODE/)).toBeTruthy());
    expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1s');
  });
});

describe('the account menu\u2019s node-mode row (doc 20 §5.4)', () => {
  function AppWithMenu() {
    return (
      <div data-testid="the-app">
        <AccountMenu actor={DISPLAY_ACTOR} />
      </div>
    );
  }
  const row = () => {
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    return screen.getByTestId('account-menu-node-mode');
  };
  const opt = (r: HTMLElement, mode: string) => within(r).getByRole('button', { name: mode }) as HTMLButtonElement;

  beforeEach(() => {
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY);
  });

  it('the owner tightens personal → server with their pass, and is told to restart', async () => {
    render(<AuthGate><AppWithMenu /></AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'));
    await createAccountThroughTheUI();
    const r = row();
    expect(opt(r, 'personal').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(opt(r, 'server'));
    await waitFor(() => expect(server.mode).toBe('server'));
    await waitFor(() => expect(screen.getByTestId('account-menu-node-mode').textContent).toMatch(/Restart the tm8 server/));
    // Inline, not the first-run frame: the app stays up.
    expect(screen.getByTestId('the-app')).toBeTruthy();
  });

  it('loosening asks first, with the warning, then records it', async () => {
    Object.assign(server, { mode: 'server', modeSet: true, modeSource: 'file', runningMode: 'server' });
    render(<AuthGate><AppWithMenu /></AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'));
    await createAccountThroughTheUI();
    const r = row();
    fireEvent.click(opt(r, 'personal'));
    expect(server.mode).toBe('server'); // nothing sent yet
    const warning = screen.getByTestId('node-mode-loosen-warning');
    expect(warning.textContent).toMatch(/trusted as the owner again/);
    fireEvent.click(within(warning).getByRole('button', { name: /switch to personal/i }));
    await waitFor(() => expect(server.mode).toBe('personal'));
  });

  it('a pinned node shows the pin and offers no button', async () => {
    server.modeSource = 'env';
    render(<AuthGate><AppWithMenu /></AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'));
    await createAccountThroughTheUI();
    const r = row();
    expect(r.textContent).toMatch(/set by TM8_NODE_MODE/);
    for (const mode of ['personal', 'peer', 'server']) expect(opt(r, mode).disabled).toBe(true);
  });

  it('the auto-owner may tighten but is never offered a loosening', async () => {
    Object.assign(server, { mode: 'peer', modeSet: true, modeSource: 'file' });
    server.autoOwner = { ...OWNER_ACCOUNT };
    server.accounts.set('owner', { ...OWNER_ACCOUNT, password: PASSWORD, isOwner: true });
    render(<AuthGate><AppWithMenu /></AuthGate>);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    const r = await waitFor(() => row());
    expect(opt(r, 'personal').disabled).toBe(true);
    expect(opt(r, 'server').disabled).toBe(false);
  });

  it('a non-owner sees no row', async () => {
    server.accounts.set('amber', { username: 'amber', password: PASSWORD, displayName: 'amber', accountId: 'acct_amber', identityId: 'id_amber' });
    render(<AuthGate><AppWithMenu /></AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1d'));
    signInThroughTheUI('amber', PASSWORD);
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    expect(screen.queryByTestId('account-menu-node-mode')).toBeNull();
  });
});

describe('the inline Peer gate on invite creation (doc 20 §5.5)', () => {
  function AppWithInvites() {
    return (
      <div data-testid="the-app">
        <InvitesPanel invites={[]} onCreate={async () => undefined} />
      </div>
    );
  }

  beforeEach(() => {
    localStorage.removeItem(NODE_CLAIM_CACHE_KEY);
  });

  it('a Personal node puts the switch where the invite button was; switching to Peer brings it back', async () => {
    render(<AuthGate><AppWithInvites /></AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'));
    await createAccountThroughTheUI();
    expect(screen.getByTestId('require-peer')).toBeTruthy();
    expect(screen.queryByTestId('invite-create')).toBeNull();
    fireEvent.click(screen.getByTestId('require-peer-switch'));
    await waitFor(() => expect(screen.getByTestId('invite-create')).toBeTruthy());
    expect(server.mode).toBe('peer');
  });

  it('a Peer node shows the invite button untouched', async () => {
    Object.assign(server, { mode: 'peer', modeSet: true, modeSource: 'file' });
    render(<AuthGate><AppWithInvites /></AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'));
    await createAccountThroughTheUI();
    expect(screen.getByTestId('invite-create')).toBeTruthy();
    expect(screen.queryByTestId('require-peer')).toBeNull();
  });

  it('a pinned Personal node names the pin and offers no switch', async () => {
    server.modeSource = 'env';
    render(<AuthGate><AppWithInvites /></AuthGate>);
    await waitFor(() => expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a'));
    await createAccountThroughTheUI();
    expect(screen.getByTestId('require-peer').textContent).toMatch(/set by TM8_NODE_MODE/);
    expect(screen.queryByTestId('require-peer-switch')).toBeNull();
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
    // The token first: without it the act is refused for a DIFFERENT reason
    // (no capability), and this test is about the password floor.
    fireEvent.change(screen.getByLabelText('SETUP TOKEN'), { target: { value: FAKE_CLAIM_TOKEN } });
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

  /**
   * THIS TEST CHANGED SHAPE, and the law it enforces did not.
   *
   * It used to require the GATE to print "STEP 1 OF 3" and then explain, in
   * the same card, that steps 2 and 3 have no operation behind them. That is
   * one way to satisfy "never draw a wizard whose last two steps do nothing" —
   * disclose the gap. Pixel verification showed what it costs: a first-time
   * viewer meets a three-dot progress indicator, finishes, and is in, having
   * been promised two steps that never come; and the explanation clearing it
   * up is written in words they have no referent for ("the oracle", "the
   * seam", `spaces.create`).
   *
   * So the gate now satisfies the SAME law by removing the wizard instead of
   * annotating it, and the disclosure stays where its reader is — the review
   * board, which exists to be diffed against the canvas. Both halves are
   * asserted here, because "the gate dropped the counter" is only honest if
   * the board still carries it.
   */
  it('the gate shows no multi-step counter it cannot honour', () => {
    render(<AuthGate>{APP}</AuthGate>);
    const frame = screen.getByTestId('auth-frame');
    expect(frame.textContent).toMatch(/first run/i);
    expect(frame.textContent).not.toMatch(/step\s*1\s*of\s*3/i);
    // and no leftover explanation of steps this viewer will never be shown
    expect(frame.textContent).not.toMatch(/spaces\.create|the oracle/i);
  });

  it('the review board keeps the designed counter AND the disclosure', () => {
    render(<AuthFlow frame="1a" onDone={() => {}} />);
    const frame = screen.getByTestId('auth-frame');
    expect(frame.textContent).toMatch(/step 1 of 3/i);
    // …states that the remaining two steps have no operation behind them,
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
    // BLOCKED STORAGE IS ALSO A COLD BROWSER: there is no cached claim answer
    // to read, so the gate renders nothing until the node replies. Awaiting
    // the card is the point of the test, not a workaround for it — a viewer
    // whose storage is blocked must still be told, and telling them requires
    // the card to arrive.
    await screen.findByLabelText('SETUP TOKEN');
    fireEvent.change(screen.getByLabelText('SETUP TOKEN'), { target: { value: FAKE_CLAIM_TOKEN } });
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
          <AccountMenu actor={DISPLAY_ACTOR} theme={theme} onThemeChange={setTheme} />
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
          <AccountMenu actor={DISPLAY_ACTOR} />
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
          <AccountMenu actor={DISPLAY_ACTOR} />
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

  /**
   * THE UTILITY GROUP — Inbox, System prompts and Copy link, moved here from
   * the top bar (task 01a07a56; the owner asked for this once before, on
   * 2026-08-31, and it was built into the Astryx redesign fork while that
   * package was the product UI).
   *
   * WHY THESE ASSERTIONS EXIST AND WHY HERE. `shell/topbar-r21.test.tsx`
   * proves the bar HANDS THESE OVER when there is an account menu. Nothing
   * proved the menu PICKS THEM UP, so the whole feature could have been
   * deleted with every test in the change still green — in the majority state,
   * a signed-in viewer with an account. That is the exact mirror of the bar's
   * own no-account gap, and it is the commoner case.
   *
   * Four of these five were ported from the Astryx fork's own
   * `src/auth/gate.test.tsx`, where they had been passing since 2026-08-31;
   * that package was deleted on 2026-09-15, so THESE are now the only copy.
   * The prompts row is new here: the 2.0 bar dropped that control without
   * rehoming it, and this package's does not.
   */
  describe('the account menu\u2019s utility group', () => {
    const openMenu = async () => {
      await createAccountThroughTheUI('amber', PASSWORD);
      fireEvent.click(screen.getByTestId('account-menu-trigger'));
      return screen.getByTestId('auth-account-menu');
    };

    it('the inbox row opens Inbox when a host wires it, and closes the menu', async () => {
      const onOpenInbox = vi.fn();
      render(
        <AuthGate>
          <div data-testid="the-app">
            <AccountMenu actor={DISPLAY_ACTOR} onOpenInbox={onOpenInbox} />
          </div>
        </AuthGate>,
      );
      const menu = await openMenu();

      const row = within(menu).getByTestId('open-inbox');
      expect(row.getAttribute('aria-disabled')).toBeNull();
      fireEvent.click(row);
      expect(onOpenInbox).toHaveBeenCalledOnce();
      /* A navigation verb closes the popover behind it — leaving it open over
         the screen it just navigated to is the defect its neighbours (Account
         & access tokens, Sign out) already avoid. */
      expect(screen.queryByTestId('auth-account-menu')).toBeNull();
    });

    it('the inbox row keeps the D28 posture without a host: announced, reachable, refused', async () => {
      render(
        <AuthGate>
          <div data-testid="the-app">
            <AccountMenu actor={DISPLAY_ACTOR} />
          </div>
        </AuthGate>,
      );
      const menu = await openMenu();

      const row = within(menu).getByTestId('open-inbox') as HTMLButtonElement;
      expect(row.getAttribute('aria-disabled')).toBe('true'); // announced
      expect(row.disabled).toBe(false); // inverted guard against the native attr
      expect(row.getAttribute('title')).toMatch(/unavailable/i); // says why
      row.focus(); // reachable
      expect(document.activeElement).toBe(row);
      // NAMED, and reachable by that name from inside the menu.
      expect(within(menu).getByRole('button', { name: 'Inbox' })).toBe(row);
    });

    /* PROMPTS IS NOT INBOX, DELIBERATELY. The bar's prompts control rendered
       only when a host wired it — it never carried the bell's refusal posture —
       and moving a control must not silently promote it to a promise it was
       not making. So: present and live when wired, absent when not. */
    it('the prompts row opens the catalog when a host wires it, and closes the menu', async () => {
      const onOpenPrompts = vi.fn();
      render(
        <AuthGate>
          <div data-testid="the-app">
            <AccountMenu actor={DISPLAY_ACTOR} onOpenPrompts={onOpenPrompts} />
          </div>
        </AuthGate>,
      );
      const menu = await openMenu();
      fireEvent.click(within(menu).getByTestId('open-prompts'));
      expect(onOpenPrompts).toHaveBeenCalledOnce();
      expect(screen.queryByTestId('auth-account-menu')).toBeNull();
    });

    /* A SEPARATE CASE, and it has to be: `openMenu` creates the account through
       the UI, and the create form is only offered once — calling it twice in
       one test finds a sign-in form and fails on a field that is not there.
       (Measured: that is exactly how the first draft of this pair failed.) */
    it('and is ABSENT when no host wires it — the move did not promote it to a promise', async () => {
      render(
        <AuthGate>
          <div data-testid="the-app">
            <AccountMenu actor={DISPLAY_ACTOR} />
          </div>
        </AuthGate>,
      );
      const menu = await openMenu();
      expect(within(menu).queryByTestId('open-prompts')).toBeNull();
      // Inbox, by contrast, is drawn here — the two rows differ on purpose.
      expect(within(menu).getByTestId('open-inbox')).toBeTruthy();
    });

    it('hosts the utility rows a host hands it, above Appearance', async () => {
      render(
        <AuthGate>
          <div data-testid="the-app">
            <AccountMenu
              actor={DISPLAY_ACTOR}
              utilityRows={<button type="button">Copy link</button>}
            />
          </div>
        </AuthGate>,
      );
      const menu = await openMenu();

      const hosted = within(menu).getByRole('button', { name: 'Copy link' });
      const inbox = within(menu).getByTestId('open-inbox');
      // Same group as Inbox — one utility cluster, not two.
      expect(hosted.closest('.auth-menu__group')).toBe(inbox.closest('.auth-menu__group'));
      // ...and that group precedes the appearance group.
      const appearance = within(menu).getByRole('group', { name: 'appearance' });
      expect(
        hosted.compareDocumentPosition(appearance) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    /* THE PORT IS A MERGE, NOT A COPY, AND THIS IS THE ASSERTION THAT SAYS SO.
       The Astryx fork's AccountMenu — the source of the four assertions
       above — had NO Agent tools row. A file copy would have deleted this
       package's, silently, and every other test here would still have passed.
       So: Agent tools survives, and it stays where it was, BELOW the new
       utility group rather than absorbed into it. */
    it('the new group does not displace or absorb Agent tools', async () => {
      render(
        <AuthGate>
          <div data-testid="the-app">
            <AccountMenu
              actor={DISPLAY_ACTOR}
              onOpenAgentTools={() => undefined}
              utilityRows={<button type="button">Copy link</button>}
            />
          </div>
        </AuthGate>,
      );
      const menu = await openMenu();

      const agentTools = within(menu).getByTestId('account-menu-agent-tools');
      const inbox = within(menu).getByTestId('open-inbox');
      // A different group from the utilities...
      expect(agentTools.closest('.auth-menu__group')).not.toBe(
        inbox.closest('.auth-menu__group'),
      );
      // ...and after them, so the move added a cluster rather than reordering
      // the menu around it.
      expect(
        inbox.compareDocumentPosition(agentTools) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('draws the utility group even with nothing hosted — Inbox is never hidden', async () => {
      render(
        <AuthGate>
          <div data-testid="the-app">
            <AccountMenu actor={DISPLAY_ACTOR} />
          </div>
        </AuthGate>,
      );
      const menu = await openMenu();
      expect(within(menu).getByTestId('open-inbox')).toBeTruthy();
    });
  });
});
