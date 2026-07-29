/**
 * CREDENTIAL FAILURE COPY — every way the local gate can say no.
 *
 * One place, so the set is countable and so no failure mode can reach the
 * screen as a raw exception string. The voice is T1-4's: exact reason plus
 * consequence, naming numbers where there are numbers.
 *
 * TWO THINGS THIS COPY DELIBERATELY DOES NOT SAY, both asserted in
 * `gate.test.tsx`:
 *
 * 1. It never distinguishes "no such account" from "wrong password". Doing so
 *    tells anyone at this browser which handles exist, for free. The gate is
 *    not a security boundary and says so — but leaking for nothing would still
 *    be a defect, and one shared message costs nothing to keep.
 *
 * 2. It never mentions an attempt counter or a lockout. The oracle draws
 *    "4 attempts left, then a 5-minute hold on this handle" (L138) and NOTHING
 *    ENFORCES EITHER. A countdown that never counts down is the same class of
 *    lie as a login that never logs in — a number reads as a fact the system
 *    computed. The frame keeps the oracle's banner shape and tells the truth
 *    inside it.
 */
import type { AuthFailure } from './session';

export function failureCopy(failure: AuthFailure): { lead: string; body: string } {
  switch (failure.kind) {
    case 'password-too-short':
      return {
        lead: 'Password too short',
        body: ` — ${failure.min} characters minimum. Nothing was created.`,
      };
    case 'name-required':
      return {
        lead: 'A name is needed',
        body: ' — the handle is derived from it, and letters, digits, - and _ are what survive.',
      };
    case 'account-exists':
      return {
        lead: 'This browser already has an account',
        body: ` — @${failure.handle}. Sign in as them, or clear this browser’s tm8 storage to start over.`,
      };
    case 'bad-credentials':
      // ONE message for both halves, on purpose. See the docblock.
      return {
        lead: 'Sign-in failed',
        body: ' — that handle and password do not match the account stored in this browser. No attempt limit is enforced: this gate is local, not a security boundary.',
      };
    case 'storage-blocked':
      return {
        lead: 'This browser is blocking storage',
        body: ' — the account cannot be saved, so you were not signed in. A session that vanished on your next reload would be worse than this refusal.',
      };
    case 'crypto-unavailable':
      return {
        lead: 'No Web Crypto on this page',
        body: ' — crypto.subtle is unavailable (usually a non-HTTPS, non-localhost origin), and the password will not be stored without being properly derived first.',
      };
  }
}

/**
 * The failed-sign-in banner names the handle that was tried, because "which
 * account" is the one piece of context that helps and leaks nothing the typist
 * did not just type themselves.
 */
export function signInFailureLead(handle: string): string {
  return handle ? `@${handle}` : 'that handle';
}
