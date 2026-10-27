/**
 * The `data-theme` an ALWAYS-DARK scope (terminal chrome, workspace centre,
 * Z4, files preview, node room, help terminals, the terminal entity panel)
 * stamps on itself — derived, like every other `data-theme` (spec v8 §1.6).
 *
 *  - `--pn-term-chrome: dark` (every built-in): `'dark'`, exactly as these
 *    scopes have always hard-coded it. The injected sheet's always-dark rule
 *    paints them with the dark sibling's ramp; nothing moves.
 *  - `--pn-term-chrome: follow`: the scope takes the ACTIVE style's derived
 *    theme. A light style gets no attribute, so the sheet's light rule (which
 *    skips `[data-theme="dark"]` subtrees) reaches the scope and a light
 *    style has a light terminal area; a dark style still gets `'dark'`.
 *
 * Without this, `follow` under a light style would leave the scope stamped
 * dark, excluded from the light rule, and falling through to tokens.css's
 * dark block — the opposite of following.
 */
import { useSyncExternalStore } from 'react';

import { getStyleState, subscribeStyle } from './style-store';

function snapshot(): 'dark' | undefined {
  const { active } = getStyleState();
  /* A null always-dark ramp IS chrome = follow (the resolver emits the ramp
     exactly when the chrome is dark), so the store needs no second flag. */
  if (active.alwaysDarkCssVars !== null) return 'dark';
  return active.darkish ? 'dark' : undefined;
}

export function useAlwaysDarkTheme(): 'dark' | undefined {
  return useSyncExternalStore(subscribeStyle, snapshot, snapshot);
}
