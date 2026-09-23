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

/*
 * THERE IS DELIBERATELY NO `clearSetupDismissal`. An earlier draft exported one
 * as "sign-out's half", by analogy with `last-place.ts`, which really does need
 * one. This module does not, and the difference is the key: `last-place` is
 * keyed by NODE alone, so one person's record is the next person's inheritance
 * and sign-out has to erase it. This key carries the ACCOUNT HANDLE, so the
 * next member to sign in on this machine reads a different key and starts
 * undismissed already. A clear function would have been dead code whose
 * existence implied the bug it was named after was still possible.
 */
