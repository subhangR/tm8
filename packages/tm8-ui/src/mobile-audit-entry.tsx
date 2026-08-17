/**
 * mobile-audit-entry — the fixture mount the layout harness photographs.
 *
 * WHY THIS FILE EXISTS AT ALL, since a harness that drives the real app would
 * obviously be better. `App` wraps everything in `AuthGate`, whose dev bypass
 * is never wired by a host, so there is NO way for an automated run to get past
 * sign-in without handling a human's password. That is a property worth keeping
 * — it is why nobody has quietly built a bypass — so the harness goes around it
 * instead of through it: mount `GateApp` DIRECTLY, with no auth wrapper, over a
 * seam that needs no node.
 *
 * WHAT MAKES THAT HONEST RATHER THAN A CHEAT. `GateApp` is the component under
 * the gate; it is where the shell fork lives (`useShellKind` →
 * `MobileShell` | desktop shell) and where every screen is composed. The auth
 * wrapper contributes no layout — it renders its children or it renders the
 * sign-in flow, never both. So the tree measured here is the tree production
 * lays out, minus a component that draws nothing when you are signed in.
 *
 * THE ONE THING THAT MUST NOT DRIFT: the CSS import list below is a COPY of
 * `main.tsx`'s. Miss one and the harness measures a stylesheet production does
 * not have, which is worse than not measuring at all — it produces a number
 * that looks like evidence. `mobile-audit-css-parity.test.ts` checks the two
 * lists against each other mechanically, because "remember to keep these in
 * sync" is not a mechanism.
 *
 * NOT SHIPPED. This entry is reachable only at `/mobile-audit.html` under
 * `vite dev`; `vite build` has one input (`index.html`) and never sees it.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import './panels/panels.css';
import './terminal/terminal.css';
import './shell/palette.css';
import './graph/graph.css';
import './servers/server.css';
import { REAL_SEAM_STORAGE_KEY } from './views/realSeamFlag';
import { GateApp } from './views/GateApp';

/**
 * FIXTURE SEAM, SET BEFORE THE MODULE THAT READS IT RUNS.
 *
 * `seamSource()` is called inside `useGateData` during the first render, and
 * `'0'` is its explicit fixture opt-in (rule 2 in `realSeamFlag.ts`). Writing
 * it here rather than in the driver keeps the fixture composition in ONE place:
 * a lane that opens `/mobile-audit.html` by hand gets exactly what the harness
 * gets, with no setup step to forget.
 *
 * Wrapped because storage can be a throwing getter on a blocked origin — the
 * same hazard `readSeamFlag` documents. A throw here would take down the mount
 * before anything rendered, and the failure would read as "the app is broken"
 * rather than "the fixture could not arm itself".
 */
try {
  localStorage.setItem(REAL_SEAM_STORAGE_KEY, '0');
} catch {
  /* Then the default applies and the app tries the REAL seam, which has no node
     under the harness. The screen says so honestly and the numbers taken off it
     would be numbers about a boot error — which is why the driver asserts it
     found a shell before it trusts anything. */
}

/**
 * NO `StrictMode`, deliberately, and this is the one place the fixture differs
 * from `main.tsx` on purpose rather than by omission.
 *
 * StrictMode double-invokes effects in development. That is a correctness
 * instrument and a good one, but it is not a layout instrument: it changes how
 * many times a screen mounts, subscribes and settles, and this harness measures
 * a SETTLED screen. Keeping it would trade nothing for a class of timing flake
 * in a tool whose entire value is that its numbers do not move.
 */
createRoot(document.getElementById('root')!).render(<GateApp />);
