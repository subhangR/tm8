/**
 * Theme choice — now a SHIM over the style store (design §5, §13 phase 1).
 *
 * WHAT CHANGED AND WHAT DID NOT. The hook's surface is unchanged on purpose:
 * `theme`, `setTheme`, `toggle`, `isSystemDefault`, the `tm8ui.theme`
 * localStorage key, and "follow the OS until the viewer chooses" all behave
 * exactly as they did. `GateApp.tsx:399` is still the single owner and
 * `MobileShell` still receives the value as a prop — a second `useTheme()`
 * would still be a second truth. What moved is WHERE THE VALUE COMES FROM:
 * `theme` is now DERIVED from the resolved style's paper luminance (§3.2)
 * rather than being the stored string itself, and the tokens come from the
 * injected sheet rather than from `data-theme` selecting a block in
 * `tokens.css`.
 *
 * WHY THE SHIM RATHER THAN A SWEEP. `AccountMenu.tsx:50-63`, `AuthFlow.tsx:130`,
 * `auth/AccountMenu.tsx:104`, `MobileShell.tsx:116-119` and the three roots in
 * `GateApp.tsx` all speak `'light' | 'dark'`. Phase 1's whole claim is that the
 * rendering does not move; changing seven call sites in the same step as
 * changing the token mechanism would make a pixel diff impossible to attribute.
 * The picker that replaces this arrives in phase 2 with the entity behind it.
 *
 * THE ORIGINAL HEADER'S LESSON IS KEPT because it is about method, not code:
 * theme used to be unpersisted `useState` seeded to light, so every reload
 * dropped the viewer's choice AND ignored their OS preference. It was found
 * early and written down as a CAPTURE PROCEDURE CAVEAT — a thing to route
 * around when taking screenshots — and never questioned, because a documented
 * workaround reads like understanding. The note that should have been a bug
 * report became a procedure instead.
 *
 * D1 governs the CONTROL's home — the account menu, never a tab-bar toggle —
 * and is unaffected by where the value is stored.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  derivedTheme,
  getStyleState,
  setTheme as setStoreTheme,
  subscribeStyle,
  watchOsTheme,
  type Theme,
} from './style-store';

export type { Theme };

export interface ThemeControl {
  theme: Theme;
  setTheme(theme: Theme): void;
  toggle(): void;
  /** True when the current value came from the OS rather than an explicit choice. */
  isSystemDefault: boolean;
}

export function useTheme(): ThemeControl {
  /* Read from the store's CURRENT state in the initialiser, not from storage:
     the store already resolved before first paint (`installActiveStyle()` in
     `main.tsx`), so this is a read of a settled value rather than a second,
     possibly disagreeing, computation of it. */
  const [snapshot, setSnapshot] = useState<{ theme: Theme; followOs: boolean }>(() => ({
    theme: derivedTheme(),
    followOs: getStyleState().followOs,
  }));

  useEffect(
    () =>
      subscribeStyle((next) => {
        setSnapshot({ theme: next.active.darkish ? 'dark' : 'light', followOs: next.followOs });
      }),
    [],
  );

  /* The OS listener is owned here rather than installed at boot so it is torn
     down with the tree. One subscription for the app: `GateApp` is the single
     `useTheme()` owner, and the store ignores OS changes once a choice is
     explicit, so a stray second mount cannot produce a second flip. */
  useEffect(() => watchOsTheme(), []);

  const setTheme = useCallback((theme: Theme) => setStoreTheme(theme), []);
  const toggle = useCallback(
    () => setStoreTheme(snapshot.theme === 'dark' ? 'light' : 'dark'),
    [snapshot.theme],
  );

  return { theme: snapshot.theme, setTheme, toggle, isSystemDefault: snapshot.followOs };
}
