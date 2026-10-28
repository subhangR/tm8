// @vitest-environment jsdom
/**
 * THE FIRST-RUN CARD NEVER MAKES ANYONE HANDLE A TOKEN THEY CAN AVOID.
 *
 * Three people reach an unclaimed node's card, and each must be able to finish
 * without copying anything:
 *   · on the server's own machine — the node answers `tokenRequired: false`,
 *     so there is no code field at all;
 *   · through the printed `#claim=` link — the link carries the code, so it is
 *     used without being shown, and it SURVIVES A RELOAD (it used to vanish:
 *     the fragment was scrubbed and nothing kept it);
 *   · with neither — one clearly labelled field, and a refusal that says the
 *     CODE was wrong rather than "the server refused that handle and password".
 *
 * Rendered under StrictMode, as `main.tsx` mounts the app (the case PR #503
 * raised: a per-mount read of a fragment that scrubs itself on first read).
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AuthFlow } from './index';
import { AuthActionsContext, type AuthActions } from './gate-context';
import { failureCopy } from './failures';
import type { AuthFailure } from './session';

const TOKEN = 'tm8c_test-claim-token';

function installSessionStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

function actionsFor(opts: { tokenRequired?: boolean; failure?: AuthFailure | null } = {}) {
  const claimNode = vi.fn(async () => true);
  const actions = {
    createAccount: vi.fn(async () => true),
    claimNode,
    signIn: vi.fn(async () => true),
    signOut: () => {},
    clearFailure: () => {},
    failure: opts.failure ?? null,
    busy: false,
    account: null,
    accounts: [],
    nodeClaim: {
      claimed: false,
      mode: 'single',
      signupPath: 'claim',
      ...(opts.tokenRequired === undefined ? {} : { tokenRequired: opts.tokenRequired }),
    },
  } as unknown as AuthActions;
  return { actions, claimNode };
}

function renderCard(actions: AuthActions): void {
  render(
    <StrictMode>
      <AuthActionsContext.Provider value={actions}>
        <AuthFlow frame="1a" onDone={() => {}} />
      </AuthActionsContext.Provider>
    </StrictMode>,
  );
}

function fillAccount(): void {
  fireEvent.change(screen.getByLabelText('YOUR NAME'), { target: { value: 'Amber' } });
  fireEvent.change(screen.getByLabelText('PASSWORD'), { target: { value: 'correct-horse' } });
}

beforeEach(() => {
  installSessionStorage();
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

describe('on the server\'s own machine', () => {
  it('asks for no setup code and claims with none', () => {
    const { actions, claimNode } = actionsFor({ tokenRequired: false });
    renderCard(actions);
    expect(screen.queryByLabelText('SETUP CODE')).toBeNull();
    // Real focus on the first thing to type, not a drawn ring.
    expect(document.activeElement).toBe(screen.getByLabelText('YOUR NAME'));
    fillAccount();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(claimNode).toHaveBeenCalledWith(null, 'Amber', 'correct-horse');
  });

  it('Enter in the password field submits', () => {
    const { actions, claimNode } = actionsFor({ tokenRequired: false });
    renderCard(actions);
    fillAccount();
    fireEvent.submit(screen.getByLabelText('PASSWORD').closest('form')!);
    expect(claimNode).toHaveBeenCalledTimes(1);
  });
});

describe('through the printed #claim= link', () => {
  it('uses the code without showing it, and scrubs it from the address bar', () => {
    window.history.replaceState(null, '', `/#claim=${TOKEN}`);
    const { actions, claimNode } = actionsFor({ tokenRequired: true });
    renderCard(actions);
    expect(screen.queryByLabelText('SETUP CODE')).toBeNull();
    expect(screen.getByTestId('claim-link-used')).toBeTruthy();
    expect(window.location.hash).toBe('');
    fillAccount();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(claimNode).toHaveBeenCalledWith(TOKEN, 'Amber', 'correct-horse');
  });

  it('still has the code after a reload mid-setup', () => {
    window.history.replaceState(null, '', `/#claim=${TOKEN}`);
    renderCard(actionsFor({ tokenRequired: true }).actions);
    cleanup(); // the reload: the fragment is already gone from the URL
    expect(window.location.hash).toBe('');

    const { actions, claimNode } = actionsFor({ tokenRequired: true });
    renderCard(actions);
    expect(screen.getByTestId('claim-link-used')).toBeTruthy();
    fillAccount();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(claimNode).toHaveBeenCalledWith(TOKEN, 'Amber', 'correct-horse');
  });

  it('reopens the field, with the code in it, when the server refuses the code', () => {
    window.history.replaceState(null, '', `/#claim=${TOKEN}`);
    renderCard(actionsFor({ tokenRequired: true, failure: { kind: 'setup-code-refused' } }).actions);
    expect((screen.getByLabelText('SETUP CODE') as HTMLInputElement).value).toBe(TOKEN);
    expect(screen.getByText(/setup code did not work/i)).toBeTruthy();
  });
});

describe('with no link, off the server\'s machine', () => {
  it('shows one labelled field and a disabled action that says why — in one line, not twice', () => {
    renderCard(actionsFor({ tokenRequired: true }).actions);
    const field = screen.getByLabelText('SETUP CODE') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
    expect(screen.getByRole('button', { name: /create account/i }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Needs the setup code above')).toBeTruthy();
  });

  it('an older node that does not say treats the code as required', () => {
    renderCard(actionsFor().actions);
    expect(screen.getByLabelText('SETUP CODE')).toBeTruthy();
  });
});

it('a refused code is never described as a refused password', () => {
  const copy = failureCopy({ kind: 'setup-code-refused' });
  expect(`${copy.lead}${copy.body}`).not.toMatch(/password|handle/i);
  expect(copy.body).toMatch(/tm8 auth claim --show/);
});
