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
 * WHAT THIS GATE IS, and the reason the copy assertions are as load-bearing
 * as the behaviour ones: the HTTP surface carries `identity.get` and NOTHING
 * else — no signup, no login, no logout. So the account is LOCAL to this
 * browser, and a gate that let a user believe otherwise would be the same lie
 * as a login form that silently succeeds, just harder to spot. Every frame
 * that performs a real credential act must say so on screen; that is asserted
 * here, not left to review.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { IdentityView } from '../data/seam';
import {
  AccountMenu,
  AuthGate,
  readLocalAccount,
  readLocalAccounts,
  readLocalSession,
  signOut,
  useAuthSession,
} from './index';

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

const APP = <div data-testid="the-app">THE APP</div>;

/** The acceptance loop's own vocabulary, so a rename cannot silently pass. */
const NAME = 'amber';
const PASSWORD = 'correct-horse';

async function createAccountThroughTheUI(name = NAME, password = PASSWORD) {
  fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: password } });
  // "Create owner account" on first run, "Create account" for a second one —
  // the card stops claiming an unclaimed server the second time through.
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

beforeEach(installStorage);
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

  it('opens on the claim frame when no local account exists yet', () => {
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a');
  });

  it('opens on the LOGIN frame when an account exists but no session does', async () => {
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
  it('creates the local account and lets the children through', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(screen.queryByTestId('auth-frame')).toBeNull();
  });

  it('never stores the password — only a salted derivation of it', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    const raw = JSON.stringify(readLocalAccounts());
    expect(raw).not.toContain(PASSWORD);
    const account = readLocalAccount()!;
    expect(account.salt.length).toBeGreaterThan(10);
    expect(account.hash.length).toBeGreaterThan(20);
    expect(account.iterations).toBeGreaterThanOrEqual(100_000);
  });

  it('refuses a password shorter than the 8 characters the card promises', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: NAME } });
    fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/8/));
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(readLocalAccounts()).toEqual([]);
  });
});

describe('leg 3 — reload keeps you in', () => {
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

  it('does NOT keep you in when only the account survives and the session does not', async () => {
    // The account and the session are separate records ON PURPOSE: sign-out
    // must not delete the account, and a surviving account must not imply a
    // surviving session. One record for both would make sign-out either
    // destroy the account or not work.
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    act(() => signOut());
    // `readLocalAccount()` now means "the SIGNED-IN account", so after
    // sign-out it is correctly null; the surviving record is in the list.
    expect(readLocalAccounts()).toHaveLength(1);
    expect(readLocalAccount()).toBeNull();
    expect(readLocalSession()).toBeNull();
  });
});

describe('leg 4 — sign out returns to the gate', () => {
  it('drops back to the flow and hides the app', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI();
    act(() => signOut());
    await waitFor(() => expect(screen.queryByTestId('the-app')).toBeNull());
    expect(screen.getByTestId('auth-frame')).toBeTruthy();
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

describe('leg 5 — sign in verifies against the local account', () => {
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
    // Naming "no such account" tells an attacker which handles exist. The
    // local gate is not a security boundary, but leaking it for free would
    // still be a defect, and the fix costs one shared message.
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
  it('discloses the local-account semantics on every frame that takes a credential', async () => {
    // The upgrade's central constraint. An enabled credential verb is only
    // honest next to a statement of what it actually does.
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.getByTestId('auth-local-note').textContent).toMatch(
      /local account on this (node|browser)/i,
    );
    await createAccountThroughTheUI();
    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());
    expect(screen.getByTestId('auth-local-note').textContent).toMatch(/local/i);
  });

  it('names the missing operations, so the gap is legible on screen', () => {
    render(<AuthGate>{APP}</AuthGate>);
    expect(screen.getByTestId('auth-local-note').textContent).toMatch(/auth ops|auth operations/i);
  });

  it('keeps the token path refused — there is no executor for it either way', async () => {
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

  it('does NOT resolve identity while signed out', () => {
    const resolveIdentity = vi.fn().mockResolvedValue(IDENTITY);
    render(<AuthGate resolveIdentity={resolveIdentity}>{APP}</AuthGate>);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('stays signed in when identity.get rejects — the gate is local, not server-backed', async () => {
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
  it('says the account cannot persist rather than pretending it did', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /create owner account/i }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/storage|cannot be saved/i),
    );
    // And crucially: it did NOT let the viewer into an app it cannot keep
    // them in. A session that vanishes on reload is worse than no session.
    expect(screen.queryByTestId('the-app')).toBeNull();
  });
});

/**
 * MULTI-ACCOUNT + THE WORKSPACE ACCOUNT MENU (user-ordered, 2026-07-29).
 *
 * "add logout option, and show the user name on the workspace. the owner name.
 * and logout, option which logs out, and i can create another account or login
 * with same account."
 *
 * The first version of this store held ONE account, so "create another" was
 * refused with `account-exists`. That was correct for a single-owner first run
 * and wrong for what the gate is actually used as. Accounts are now a list.
 */
describe('more than one local account', () => {
  it('creates a second account without destroying the first', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);
    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());

    // From the login frame there must be a way to make a NEW one.
    fireEvent.click(screen.getByRole('button', { name: /create another account/i }));
    expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a');
    await createAccountThroughTheUI('nadia', 'another-password');

    expect(readLocalAccounts().map((a) => a.handle).sort()).toEqual(['amber', 'nadia']);
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
    expect(readLocalSession()!.handle).toBe('amber');

    act(() => signOut());
    await waitFor(() => expect(screen.getByTestId('auth-frame')).toBeTruthy());

    // the second, with ITS password — and NOT with the first's
    await signInThroughTheUI('nadia', PASSWORD);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByTestId('the-app')).toBeNull();

    await signInThroughTheUI('nadia', 'another-password');
    await waitFor(() => expect(screen.getByTestId('the-app')).toBeTruthy());
    expect(readLocalSession()!.handle).toBe('nadia');
  });

  it('refuses a handle that is already taken, and says which', async () => {
    render(<AuthGate>{APP}</AuthGate>);
    await createAccountThroughTheUI('amber', PASSWORD);
    act(() => signOut());
    fireEvent.click(screen.getByRole('button', { name: /create another account/i }));
    fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: 'amber' } });
    fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: /create owner account|create account/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/@amber/));
    expect(readLocalAccounts()).toHaveLength(1);
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

  it('names the LOCAL account, never a server identity it does not have', async () => {
    // The menu must not label a local handle as though the node vouched for
    // it. Whatever it says about provenance has to be true.
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
    expect(screen.getByTestId('auth-account-menu').textContent).toMatch(/local account/i);
  });
});
