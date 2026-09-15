/**
 * WHICH TOP BAR THIS DEVICE GETS — the in-app half of the rollback plan.
 *
 * The owner asked for a redesigned bar AND for "a backup plan to always roll
 * back if it doesn't build properly". Those are two different failures and they
 * need two different mechanisms:
 *
 *   · A BAD BUILD — the bundle fails to compile, or boots broken. Nothing
 *     inside the bundle can help: a flag in a bundle that never loads is not a
 *     control. That is the DEPLOY's job — keep the last known-good `dist` and
 *     restore it by an atomic directory swap. `packages/server/src/http/static.ts`
 *     streams every file per request with no content cache, so such a swap is
 *     picked up live and never needs the service restarted.
 *   · THE BUILD IS FINE AND THE BAR IS UNWANTED. That is this file.
 *
 * WHY NOT THE UI-2.0 SWITCH, which used to look like this control. Because it
 * never did this job: `/ui-2.0/` served a whole separate package, ~35,600 lines
 * divergent from this one and missing about twenty commits of product work.
 * "Switch back" there returned a DIFFERENT, STALER PRODUCT, not the bar you had
 * ten minutes ago. It was a door to an alternate UI, never a rollback, and it
 * was never sold as one. The alternate package was deleted on 2026-09-15 and
 * the door with it; THIS remains the only per-device rollback, and the reason
 * it has to be a separate mechanism is the paragraph above, not the door.
 *
 * PER DEVICE, NOT PER ACCOUNT — the same rule `mobile/useShellKind` follows for
 * the shell override, and for the same reason: a preference set on a laptop
 * must not silently follow someone onto a phone. Storage access is wrapped
 * because it THROWS rather than returning null in Safari private mode and some
 * embedded webviews; a storage failure means "no preference", never a crash
 * before the app can pick a bar.
 *
 * THE URL WINS, and does not persist. `?topbar=legacy` lets someone be talked
 * through a rollback over a call without first finding the menu row — and lets
 * a report say "open this link" and mean it. It deliberately does NOT write to
 * storage: a link handed round must not silently re-pin every device that
 * opens it.
 */
export type TopBarVersion = 'current' | 'legacy';

/** Device-scoped, deliberately un-namespaced by server or account. */
export const TOPBAR_VERSION_KEY = 'tm8.topbar-version';

const asVersion = (value: string | null): TopBarVersion | null =>
  value === 'current' || value === 'legacy' ? value : null;

/**
 * The bar this device should render. `current` whenever nothing says otherwise
 * — an unreadable store, an unknown value and a missing key all mean the same
 * thing, which is the only answer that cannot strand somebody on the old bar
 * because their browser refused a read.
 */
export function topBarVersion(): TopBarVersion {
  if (typeof window === 'undefined') return 'current';

  const fromUrl = asVersion(new URLSearchParams(window.location.search).get('topbar'));
  if (fromUrl) return fromUrl;

  try {
    return asVersion(window.localStorage.getItem(TOPBAR_VERSION_KEY)) ?? 'current';
  } catch {
    return 'current';
  }
}

/**
 * Pin this device to a bar. Writing `current` REMOVES the key rather than
 * storing it, so a device that opts back in is indistinguishable from one that
 * never opted out — there is no third state for a later reader to interpret.
 *
 * The caller reloads. Both bars are mounted by `GateApp` at the top of the
 * tree, above the router, and swapping them under a live tree would remount
 * every screen below; a reload is the honest way to change something this
 * structural, and it is what the UI-2.0 door did for the same reason.
 */
export function setTopBarVersion(next: TopBarVersion): void {
  if (typeof window === 'undefined') return;
  try {
    if (next === 'current') window.localStorage.removeItem(TOPBAR_VERSION_KEY);
    else window.localStorage.setItem(TOPBAR_VERSION_KEY, next);
  } catch {
    /* A device that cannot store a preference still gets the current bar, and
       `?topbar=legacy` still works for the session. Refusing to render over a
       storage failure would be worse than not remembering. */
  }
}
