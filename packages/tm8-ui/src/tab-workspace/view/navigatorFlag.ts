/**
 * THE MERGED LEFT NAVIGATOR'S FLAG — `tm8.ui.navigator` (design doc
 * 01a1465d-a2b7 §10 "Rollout", task 01a1469f-94a7).
 *
 * ON: one ~300px column (`Navigator.tsx`) holds ＋ New, the pinned kinds, All
 * kinds, the selected kind's list and the footer. OFF: today's `WorkspaceRail`
 * plus the `Browser` column, byte for byte — the flag exists so the old shell
 * can be served to everyone while the new one is shown to the friends who gave
 * the feedback, so OFF is the default and must stay a true no-op.
 *
 * DEFAULT OFF, which is the OPPOSITE of `realSeamFlag` and
 * `liveTerminalFlag`'s defaults, and deliberately so: those two gate a
 * finished production surface, this one gates an unlanded redesign of the
 * whole left side of the app. It flips to ON (and then goes away with the old
 * rail) at the end of the rollout week.
 *
 * `MODE`, NOT `DEV`, and the `typeof localStorage` INSIDE the try: both copied
 * from `views/realSeamFlag.ts`, which carries the measured reasoning — a
 * `.DEV` read reports false on the :4612 instance this gets verified on, and
 * storage can be a throwing getter rather than merely absent. Neither matters
 * for the default here (nothing is read when nobody opted in), but the shape
 * is kept so the three flags stay one pattern.
 */
import { LAYOUT_BOUNDS } from '../runtime/types';

export interface NavigatorEnv {
  MODE?: string;
  VITE_TM8_UI_NAVIGATOR?: string;
}

/** The localStorage key IS the flag's published name: `tm8.ui.navigator`. */
export const NAVIGATOR_STORAGE_KEY = 'tm8.ui.navigator';

export function resolveNavigatorEnabled(env: NavigatorEnv, storedFlag: string | null): boolean {
  const envFlag = env.VITE_TM8_UI_NAVIGATOR;
  if (envFlag != null && envFlag !== '') return envFlag === '1';
  if (storedFlag !== null) return storedFlag === '1';
  return false;
}

function readStoredFlag(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(NAVIGATOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function isNavigatorEnabled(): boolean {
  return resolveNavigatorEnabled(import.meta.env as unknown as NavigatorEnv, readStoredFlag());
}

/**
 * THE PINNED-ONLY RAIL — `tm8.ui.navigator = 'rail'` (Subhang, 2026-10-17).
 * The other arrangement of the same left side: the icon rail stays as its own
 * column beside the list, but draws ONLY the pinned kinds; every other kind
 * and source folds behind one "More kinds" row. `isNavigatorEnabled()` reads
 * false for it, so the grid, the browser's ＋ New and every other surface are
 * the two-column shell exactly as it ships with the flag off.
 */
export function resolvePinnedRailEnabled(env: NavigatorEnv, storedFlag: string | null): boolean {
  const envFlag = env.VITE_TM8_UI_NAVIGATOR;
  if (envFlag != null && envFlag !== '') return envFlag === 'rail';
  if (storedFlag !== null) return storedFlag === 'rail';
  /* THE DEFAULT (Subhang, 2026-10-18: "make this new UI the default"): with
     nothing stored, the pinned-rail layout is ON. A device opts out by storing
     any other value (`off`, or `1` for the merged navigator). The test build
     keeps the old default so suites written against the classic rail stay
     meaningful; the rail's own suites opt in explicitly. */
  return env.MODE !== 'test';
}

export function isPinnedRailEnabled(): boolean {
  return resolvePinnedRailEnabled(import.meta.env as unknown as NavigatorEnv, readStoredFlag());
}

/**
 * WIDTH BOUNDS FOR THE COLUMN THAT IS ACTUALLY ON SCREEN.
 *
 * `LAYOUT_BOUNDS.browserWidth` in the contract widened to {240, 480, 300} —
 * the navigator's range (§4) — because the persisted `browserWidth` is the
 * field the navigator's width rides on and a server that validates
 * `workspace.layout.set` has to accept 240 (§11 risk 6). But widening the
 * CONTRACT clamp must not change what the OLD browser does: with the flag off
 * the column would have started 20px narrower and dragged 40px further in,
 * which is a visible change to a surface the flag promises is untouched.
 *
 * So the clamp is the union (the contract's, which both states fit inside) and
 * the min / initial the resizer and a fresh store use come from here.
 */
export const LEGACY_BROWSER_BOUNDS = { min: 280, max: 480, initial: 320 } as const;

export function browserBounds(): { min: number; max: number; initial: number } {
  return isNavigatorEnabled() ? LAYOUT_BOUNDS.browserWidth : LEGACY_BROWSER_BOUNDS;
}
