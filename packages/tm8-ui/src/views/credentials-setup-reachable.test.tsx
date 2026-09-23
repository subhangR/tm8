// @vitest-environment jsdom
/**
 * IS THE SETUP FLOW ACTUALLY REACHABLE? — the test `settings-credentials/
 * mounted.test.tsx` says four surfaces in this repo needed and did not have.
 *
 * A source scan proves `GateApp` MENTIONS the dialog. It cannot prove the
 * dialog ever appears, and the gap between those two claims is exactly where
 * an unreachable surface lives: every guard on the auto-open path — an account,
 * a space, a readable status, an undismissed member — is a way for the flow to
 * correctly render nothing forever.
 *
 * WHY THE GATE'S OTHER TESTS DO NOT COVER THIS. They render `<GateApp />` bare,
 * outside an `<AuthGate>`, so `useAuthActions()` answers null and the auto-open
 * effect never runs. That is why mounting this modal broke none of them — and
 * it is also why none of them is evidence. This file supplies the account those
 * tests deliberately do without.
 */
import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { GateApp } from './GateApp';
import { AuthActionsContext, type AuthActions } from '../auth/gate-context';
import { navStore, resetNav } from '../stores/navStore';

/**
 * Enough of an AuthGate to satisfy the one thing GateApp reads: `account`.
 * The verbs refuse rather than resolve — nothing in this file dispatches one,
 * and a stub that silently succeeded would be free to hide a call that should
 * not be happening.
 */
function actions(handle: string): AuthActions {
  const refuse = () => Promise.reject(new Error('no auth verb in this test'));
  return {
    account: { accountId: 'acct-1', handle, isOwner: true },
    accounts: [],
    nodeClaim: null,
    failure: null,
    busy: false,
    createAccount: refuse,
    claimNode: refuse,
    signIn: refuse,
    signOut: refuse,
    clearFailure: () => undefined,
  } as unknown as AuthActions;
}

function renderSignedIn(handle = 'someone') {
  resetNav();
  window.localStorage.clear();
  window.location.hash = '';
  window.localStorage.setItem(
    'tm8.last-place.v1.local',
    JSON.stringify({
      spaceId: 'sp-atelier',
      targets: { 'sp-atelier': { type: 'view', ref: 'workspace' } },
    }),
  );
  return render(
    <AuthActionsContext.Provider value={actions(handle)}>
      <GateApp />
    </AuthActionsContext.Provider>,
  );
}

describe('the credential setup flow reaches a signed-in member', () => {
  /* The fixture seam has anthropic CONNECTED and `gitCredentialStore: 'absent'`,
     which makes GitHub UNKNOWN — so this member has the agent half and not the
     git half. Incomplete, and readable, which is precisely the case the flow
     exists for. */
  it('opens itself for a member who has not finished', async () => {
    const { findByTestId } = renderSignedIn();
    const dialog = await findByTestId('credentials-setup-dialog');
    expect(dialog).toBeTruthy();
    // On the welcome, with the agent half already ticked from the real read.
    await waitFor(() =>
      expect(dialog.querySelector('[data-testid="cset-check-agent"]')?.getAttribute('data-done'))
        .toBe('true'),
    );
    expect(
      dialog.querySelector('[data-testid="cset-check-git"]')?.getAttribute('data-done'),
    ).toBe('false');
  });

  /* AND IT BELIEVES A MEMBER WHO SAID LATER — across a reload, which is the
     whole point of persisting it. The key is per (node, account), so this also
     pins that the dismissal is keyed at all: a browser-wide key would make the
     second member below inherit the first one's answer. */
  it('does not open for a member who already dismissed it', async () => {
    const first = renderSignedIn('dismissive');
    const dialog = await first.findByTestId('credentials-setup-dialog');
    (dialog.querySelector('[data-testid="cset-later"]') as HTMLButtonElement).click();
    await waitFor(() => expect(first.queryByTestId('credentials-setup-dialog')).toBeNull());
    first.unmount();

    // A fresh boot as the SAME account: still dismissed.
    const again = renderSignedInKeepingStorage('dismissive');
    await waitFor(() => expect(again.getByTestId('workspace-grid')).toBeTruthy());
    expect(again.queryByTestId('credentials-setup-dialog')).toBeNull();
    again.unmount();

    // A DIFFERENT account on the same machine is NOT dismissed — one person's
    // "later" must never silence the flow for the next person to sign in here.
    const other = renderSignedInKeepingStorage('newcomer');
    expect(await other.findByTestId('credentials-setup-dialog')).toBeTruthy();
    other.unmount();
  });
});

/** A reboot that keeps localStorage — the dismissal has to survive it. */
function renderSignedInKeepingStorage(handle: string) {
  resetNav();
  window.location.hash = '';
  navStore.getState();
  return render(
    <AuthActionsContext.Provider value={actions(handle)}>
      <GateApp />
    </AuthActionsContext.Provider>,
  );
}
