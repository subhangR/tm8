/**
 * The thin live-window wrapper around §4.4's decision.
 *
 * EVERYTHING DECISION-SHAPED LIVES IN `shell-for.ts` and is unit-tested there
 * without a DOM. This hook does only the three things that genuinely need a
 * live browser: read the pointer media query, read the viewport width, and
 * read the user's stored per-device override. It contains no rule of its own —
 * if a condition ever appears in this file, it belongs in the predicate.
 *
 * This split is `usePanelEngine`/`geometry` again, deliberately: the thing that
 * must be provably correct must not need a DOM to prove it.
 *
 * THE OVERRIDE IS STORED PER DEVICE, NOT PER ACCOUNT (§4.4). A user with a
 * phone and a laptop must not have a preference set on one silently apply to
 * the other, so this uses plain device storage rather than the per-server
 * storage in `App.tsx:17`, which is the wrong scope for it.
 *
 * ── READ THIS BEFORE YOU WRITE THE FIRST jsdom TEST FOR THIS HOOK ─────────
 *
 * There is deliberately no jsdom test here yet: everything decidable lives in
 * `shell-for.ts` and is proved without a DOM. The moment you add one that
 * RENDERS this hook inside anything that can navigate, you inherit a known
 * trap, and it is written down here so you inherit the CAUSE rather than the
 * symptom.
 *
 * RESET THE HASH BETWEEN CASES:
 *
 *     beforeEach(() => { window.location.hash = ''; resetNav(); });
 *
 * jsdom keeps ONE `window.location` per test FILE. Once the router is mounted
 * the address is a LIVE INPUT, so a case that navigates LEAVES ITS ADDRESS
 * BEHIND and the next case in that file boots from it. `resetNav()` alone
 * stopped being a reset the day the router mounted.
 *
 * The failure does not look like one bug. It looks like a scatter of unrelated
 * red across cases that never touched the address — the router-mount lane hit
 * exactly this and it cost them eight failures that were ONE MISSING LINE, and
 * it was misdiagnosed before it was found. If this file's tests ever go
 * mysteriously and broadly red, THE FIRST HYPOTHESIS IS ONE LEAK, NOT MANY
 * BUGS.
 */
import { useCallback, useEffect, useState } from 'react';
import { asShellKind, shellFor, type PointerType, type ShellKind } from './shell-for';

/** `(pointer: coarse)` — the media query §4.4 rules on. */
const COARSE_POINTER = '(pointer: coarse)';

/**
 * Device-scoped storage key for the override. Deliberately un-namespaced by
 * server or account: the whole point is that this preference belongs to the
 * DEVICE you are holding.
 */
export const SHELL_OVERRIDE_KEY = 'tm8.shell-override';

interface ViewportEnv {
  readonly pointer: PointerType;
  readonly width: number;
}

/**
 * Reads the live environment. SSR- and test-safe: with no `window` it reports
 * a fine pointer at an unmeasurable width, which `shellFor` resolves to
 * desktop — the honest answer when nothing has been measured.
 */
function readEnv(): ViewportEnv {
  if (typeof window === 'undefined') return { pointer: 'fine', width: Number.NaN };
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia(COARSE_POINTER).matches;
  return { pointer: coarse ? 'coarse' : 'fine', width: window.innerWidth };
}

/**
 * Reads the stored override. Storage access is wrapped because it THROWS
 * rather than returning null in Safari private mode and under some embedded
 * webviews — precisely the environments this shell exists to serve. A storage
 * failure means "no preference", never a crash before the app can pick a shell.
 */
function readOverride(): ShellKind | null {
  if (typeof window === 'undefined') return null;
  try {
    return asShellKind(window.localStorage.getItem(SHELL_OVERRIDE_KEY));
  } catch {
    return null;
  }
}

export interface ShellSelection {
  /** Which shell should render, right now. */
  readonly shell: ShellKind;
  /** The user's explicit choice, or `null` when they are letting the rule decide. */
  readonly override: ShellKind | null;
  /** Set the per-device override; `null` hands the decision back to the rule. */
  readonly setOverride: (next: ShellKind | null) => void;
}

/**
 * Which shell renders, kept live against pointer and width changes.
 *
 * Subscribes to BOTH inputs, not just width: `(pointer: coarse)` genuinely
 * changes at runtime — plugging a mouse into a tablet, or a device switching
 * between touch and trackpad modes — and a fork that only watches resize would
 * hold the wrong shell until something else forced a re-render.
 */
export function useShellKind(): ShellSelection {
  const [env, setEnv] = useState<ViewportEnv>(readEnv);
  const [override, setOverrideState] = useState<ShellKind | null>(readOverride);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    /* Re-read once on mount. The initial state was computed during render,
       which under SSR or a hydrated first paint may predate a real window. */
    setEnv(readEnv());
    setOverrideState(readOverride());

    const sync = () => setEnv(readEnv());
    window.addEventListener('resize', sync);

    const query = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE_POINTER) : null;
    /* `addEventListener` on a MediaQueryList is the modern spelling; older
       WebKit — which is exactly the phone population in scope here — only has
       the deprecated `addListener`. Both are handled rather than assumed. */
    query?.addEventListener?.('change', sync);

    /* Storage events fire for OTHER tabs on this device, which is the right
       scope for a per-device preference: toggle the shell in one tab and the
       others follow. It does not fire for our own writes — `setOverride`
       updates local state directly for those. */
    const syncOverride = (event: StorageEvent) => {
      if (event.key === null || event.key === SHELL_OVERRIDE_KEY) setOverrideState(readOverride());
    };
    window.addEventListener('storage', syncOverride);

    return () => {
      window.removeEventListener('resize', sync);
      query?.removeEventListener?.('change', sync);
      window.removeEventListener('storage', syncOverride);
    };
  }, []);

  const setOverride = useCallback((next: ShellKind | null) => {
    setOverrideState(next);
    if (typeof window === 'undefined') return;
    try {
      if (next === null) window.localStorage.removeItem(SHELL_OVERRIDE_KEY);
      else window.localStorage.setItem(SHELL_OVERRIDE_KEY, next);
    } catch {
      /* Storage refused. The choice still applies to this session — it simply
         will not survive a reload, which is a better outcome than refusing the
         user's explicit request. */
    }
  }, []);

  return { shell: shellFor({ ...env, override }), override, setOverride };
}
