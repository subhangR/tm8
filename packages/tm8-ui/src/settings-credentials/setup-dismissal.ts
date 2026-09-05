/**
 * "LATER" — the one bit of state that says a member has waved this flow away.
 *
 * KEYED BY ACCOUNT, NOT BY BROWSER, and that is the whole design. `last-place`
 * records the same hazard for the same storage: a record written by one person
 * outlives their session, so the next person to sign in on the same machine
 * inherits it. There, inheriting meant landing on a stranger's last entity;
 * here it would mean a brand-new member never being offered the setup flow at
 * all, because somebody else dismissed it on this laptop last week. The account
 * handle in the key is what prevents that.
 *
 * IT IS A CONVENIENCE, AND IT FAILS OPEN. Storage can be absent or throw under
 * a disabled-storage policy; every path below catches and answers "not
 * dismissed". Offering the flow one extra time is a mild annoyance. Suppressing
 * it because `getItem` threw is a member who never connects a credential and
 * never learns why their agents cannot push.
 *
 * IT IS ALSO NOT THE GATE. `setup-gate` decides whether the account is finished;
 * this only records that the member asked to be left alone about it. A member
 * who dismissed and later connected everything is finished on the strength of
 * the measurement, not this flag — which is why `clearSetupDismissal` exists for
 * sign-out and nothing reads this value without also reading the status.
 */
const KEY_PREFIX = 'tm8.credentials-setup-dismissed.v1';

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function keyFor(nodeKey: string, accountHandle: string): string {
  return `${KEY_PREFIX}.${nodeKey}.${accountHandle}`;
}

export function readSetupDismissed(nodeKey: string, accountHandle: string): boolean {
  const store = storage();
  if (!store) return false;
  try {
    return store.getItem(keyFor(nodeKey, accountHandle)) === '1';
  } catch {
    return false;
  }
}

export function writeSetupDismissed(nodeKey: string, accountHandle: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(keyFor(nodeKey, accountHandle), '1');
  } catch {
    /* a preference that cannot be saved is not an error worth surfacing */
  }
}

/** Sign-out's half: the next member on this machine starts undismissed. */
export function clearSetupDismissal(nodeKey: string, accountHandle: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(keyFor(nodeKey, accountHandle));
  } catch {
    /* nothing to do; the key is keyed by account anyway */
  }
}
