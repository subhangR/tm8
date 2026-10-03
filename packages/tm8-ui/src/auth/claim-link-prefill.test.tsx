// @vitest-environment jsdom
/**
 * THE PRINTED SETUP LINK MUST FILL THE FIELD IT PROMISES TO FILL.
 *
 * At first boot the server prints `http://host/#claim=<token>`, and the card it
 * lands on says, in its own copy, "open that link and the code below fills
 * itself in". When it does not, `Create account` sits disabled under a note
 * repeating the instruction the operator has just followed, and nothing on
 * screen distinguishes a bad link from a bad token from a broken server. The
 * only way through is to know that the token is also in
 * `<dataDir>/setup-token` and to paste it by hand.
 *
 * RENDERED UNDER StrictMode ON PURPOSE. `main.tsx` mounts the app inside
 * `<React.StrictMode>`, and a plain `render()` cannot see this class of defect
 * at all: reading the fragment SCRUBS it, so a per-mount read gets the token
 * exactly once and the empty string every time after. Strict mode double-invokes
 * render and then unmounts and remounts — so in the real app the last read
 * always won, and it always lost.
 *
 * ITS OWN FILE, not a case in gate.test.tsx, because the capture is per page
 * load: any earlier test in the same file that mounts this card would consume
 * it, and the assertion below would be measuring the memo rather than the
 * behaviour. One file is one document.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { AuthFlow } from './index';
import { AuthActionsContext, type AuthActions } from './gate-context';

const TOKEN = 'tm8c_test-claim-token';

/**
 * The smallest gate that makes this card perform the CLAIM act: the field
 * exists only when the node has answered `claimed: false`. Everything else is
 * inert on purpose — this asserts what the field holds, not what the button does.
 */
const UNCLAIMED = {
  createAccount: async () => {},
  claimNode: async () => {},
  signIn: async () => {},
  signOut: () => {},
  clearFailure: () => {},
  failure: null,
  busy: false,
  account: null,
  accounts: [],
  nodeClaim: { claimed: false, mode: 'single', signupPath: 'claim' },
} as unknown as AuthActions;

function renderClaimCard(): void {
  render(
    <StrictMode>
      <AuthActionsContext.Provider value={UNCLAIMED}>
        <AuthFlow frame="1a" onDone={() => {}} />
      </AuthActionsContext.Provider>
    </StrictMode>,
  );
}

describe('the #claim= link fills the setup-token field', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', `/#claim=${TOKEN}`);
  });
  afterEach(cleanup);

  it('arrives in the field even though StrictMode mounts the card twice', () => {
    renderClaimCard();
    expect((screen.getByLabelText('SETUP TOKEN') as HTMLInputElement).value).toBe(TOKEN);
    // And out of the address bar the moment it is in the field: still
    // single-use and still burned server-side, but a screenshot, a
    // shoulder-surfer or the back button no longer carries it.
    expect(window.location.hash).toBe('');
  });
});
