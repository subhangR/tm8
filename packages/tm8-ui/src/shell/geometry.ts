/**
 * THE GEOMETRY LAW — pure functions, no state, no React, no store import.
 *
 * LLD §5.1 (C_min + floors) and §5.3 (admission, refusal, demotion) live here
 * as total functions over plain `{ stack, pinned, centerWidth }`. They own no
 * state: A1a's navStore owns the state machine (§5.2) and calls these; this
 * module never imports it. That split is deliberate — a demotion loop written
 * in two places is two loops that disagree.
 *
 * L4 is the binding law: every shrinkable track has a floor. Zero-floored
 * minmax tracks and unfloored `overflow:hidden` flex are forbidden (02-LAYOUT
 * §6), which is why the floors below are exported as constants and consumed by
 * the CSS through custom properties rather than re-typed into a stylesheet.
 */
import type { EntityId } from '@tm8/contract';

// ---------------------------------------------------------------------------
// Floors and dials (L4, 02-LAYOUT §6; restated at LLD §5.1)
// ---------------------------------------------------------------------------

/** Gap between workspace columns. WLT's gap law wins over the old 6px resizer track. */
export const GRID_GAP = 8;

/** One panel column. The unit C_min is built from. */
export const PANEL_COL_MIN = 320;

/** Menu rail: two discrete states, never a continuum (02-LAYOUT §1). */
export const MENU_COLLAPSED = 48;
export const MENU_EXPANDED = 165;

/** Server rail: hidden or 48. Phase 1 wires only the implicit local server (R10). */
export const SERVER_RAIL_HIDDEN = 0;
export const SERVER_RAIL_SHOWN = 48;

/** Workspace side-panel floors. */
export const LEFT_PANEL_MIN = 200;
export const RIGHT_PANEL_MIN = 220;

/** Side-panel defaults — 02-LAYOUT §2 decides these; LLD §16 records them as NOT open. */
export const LEFT_PANEL_DEFAULT = 240;
export const RIGHT_PANEL_DEFAULT = 319;

/** Terminal host floor (L4). Owned by the terminal lane; exported so the floor set is one list. */
export const TERMINAL_HOST_MIN_HEIGHT = 160;

/** §5.3 + the inherited nav store's oracle value. */
export const MAX_PINNED = 3;

// ---------------------------------------------------------------------------
// C_min — the law
// ---------------------------------------------------------------------------

/**
 * Panel slots occupied in the center: every pin is its own column, and the
 * whole stack shares ONE column (stack-top rendered, rest behind it).
 *
 * `V = pinned.length + (stack.length > 0 ? 1 : 0)` — LLD §5.1.
 */
export function panelSlots(state: { stack: readonly EntityId[]; pinned: readonly EntityId[] }): number {
  return state.pinned.length + (state.stack.length > 0 ? 1 : 0);
}

/**
 * `C_min = max(320, V·320 + max(0, V−1)·8)` — LLD §5.1.
 *
 * | V     | 0   | 1   | 2   | 3   | 4    |
 * | C_min | 320 | 320 | 648 | 976 | 1304 |
 *
 * The `max(320, …)` arm is what makes V=0 (empty center: live-session roster
 * + grammar hint, 02-LAYOUT §2.2) claim the same floor as V=1 — the center is
 * never allowed to collapse just because nothing is open in it.
 */
export function cMin(slots: number): number {
  const v = Math.max(0, slots);
  return Math.max(PANEL_COL_MIN, v * PANEL_COL_MIN + Math.max(0, v - 1) * GRID_GAP);
}

/** Convenience: C_min for a given panel state. */
export function cMinFor(state: { stack: readonly EntityId[]; pinned: readonly EntityId[] }): number {
  return cMin(panelSlots(state));
}

// ---------------------------------------------------------------------------
// Admission (§5.3)
// ---------------------------------------------------------------------------

/**
 * Refusal reasons are COPY, not codes — they render on the pin control itself
 * as disabled-with-reason (L6: never a silent no-op).
 *
 * The SHAPE is the T1-4 honesty vocabulary, form A: a bold **cause** line and
 * a mono **remedy** line. The canvas footer rule is binding on the wording —
 * *"reasons name numbers (3 pins, 8 slots) so they read as fact, not apology"*
 * — which is why `remedy` is computed from the actual measurement rather than
 * being a constant. LLD §5.3's prose ("center too narrow — unpin or widen",
 * "3 pins max") is the summary; T1-4 draws the shipped strings, and §16 leaves
 * exact disabled-reason copy to the build. Ledgered as a D-entry.
 */
export type PinRefusalReason = 'narrow' | 'max-pins' | 'pool-capacity';

export interface PinRefusal {
  reason: PinRefusalReason;
  /** Bold line: what went wrong. T1-4 form A line 1. */
  cause: string;
  /** Mono line: what to do about it, naming the numbers. T1-4 form A line 2. */
  remedy: string;
}

export type PinAdmission = { admitted: true } | ({ admitted: false } & PinRefusal);

/**
 * Facts about the terminal pool, supplied BY THE CALLER.
 *
 * §9.2's constraint is "never more simultaneous leases than k−1". Whether the
 * candidate would take a lease at all is a per-kind fact, and §15.2 makes a
 * kind literal anywhere outside `domain/` a build failure — so shell asks for
 * the answer instead of computing it. When the caller omits `pool`, this
 * clause is genuinely NOT evaluated (the terminal lane wires it); that is a
 * stated gap, not a silently-passing check.
 */
export interface PoolFacts {
  /** Leases currently held. */
  activeLeases: number;
  /** The pool's `k` (§9.2 clamps k ≥ MAX_PINNED + 2 = 5). */
  capacity: number;
  /** Does admitting THIS candidate take a lease? Registry-derived by the caller. */
  candidateTakesLease: boolean;
}

export interface AdmissionInput {
  /** Panel state BEFORE the pin. */
  stack: readonly EntityId[];
  pinned: readonly EntityId[];
  /** The id being pinned — expected to be on the stack (pin moves stack → pinned). */
  id: EntityId;
  /** MEASURED center width. §5.3 says measured, so callers pass a measurement, never a guess. */
  centerWidth: number;
  pool?: PoolFacts;
}

/**
 * Pin is allowed iff, per §5.3, ALL of:
 *   1. `pinned.length < MAX_PINNED`,
 *   2. measured `centerWidth ≥ C_min(V′)` for the POST-admission V′,
 *   3. the pool lease constraint (`activeLeases ≤ k−1` after admission).
 *
 * Note V′ is not simply V+1: pinning the last stack entry empties the stack,
 * so the stack's own slot disappears and V′ === V. Pinning the only stack
 * entry is therefore always geometrically free.
 */
export function admitPin(input: AdmissionInput): PinAdmission {
  const { stack, pinned, id, centerWidth, pool } = input;

  if (pinned.length >= MAX_PINNED) {
    return {
      admitted: false,
      reason: 'max-pins',
      cause: `Can't pin — ${MAX_PINNED} panels pinned`,
      remedy: `unpin one first · max ${MAX_PINNED} (02 §2.1)`,
    };
  }

  const nextStack = stack.filter((entry) => entry !== id);
  const nextPinned = pinned.includes(id) ? pinned : [...pinned, id];
  const slots = panelSlots({ stack: nextStack, pinned: nextPinned });
  const required = cMin(slots);
  if (centerWidth < required) {
    return {
      admitted: false,
      reason: 'narrow',
      cause: "Can't pin — center too narrow",
      remedy: `needs ${required}px for ${slots} columns · now ${Math.round(centerWidth)}`,
    };
  }

  if (pool && pool.candidateTakesLease && pool.activeLeases + 1 > pool.capacity - 1) {
    return {
      admitted: false,
      reason: 'pool-capacity',
      cause: "Can't pin — terminal capacity reached",
      remedy: `${pool.activeLeases} of ${pool.capacity - 1} terminal slots in use · close one first`,
    };
  }

  return { admitted: true };
}

// ---------------------------------------------------------------------------
// Normalization — the demotion loop (§5.3)
// ---------------------------------------------------------------------------

export interface NormalizeInput {
  stack: readonly EntityId[];
  pinned: readonly EntityId[];
  /** MEASURED center width. Constant across the loop — demotion changes V, not the viewport. */
  centerWidth: number;
}

export interface NormalizeResult {
  stack: EntityId[];
  pinned: EntityId[];
  /** Predicate(s) that caused this settle; null when the input was already settled. */
  cause: 'width' | 'max-pins' | 'both' | null;
  /** Ids demoted by THIS settle, oldest-first — the NoticeHost demotion notice reads these. */
  demoted: EntityId[];
  /**
   * True when the loop stopped with the constraint still violated: pins are
   * exhausted and the center is still under its floor. This is the C-3 EXIT
   * STATE (SPEC-FINAL C-3 / §4.7.4) — normalization is NOT the responsible
   * mechanism here; the stack-top renders at the grid floor and the §5.1
   * breakpoint machinery (see `solveWorkspace`) takes over. Normalization
   * never empties the stack to chase a width.
   */
  exhausted: boolean;
}

/**
 * `while (centerWidth < C_min(V) OR pinned.length > MAX_PINNED)` demote the
 * OLDEST pin onto the stack top — LLD §5.3.
 *
 * Two properties the tests pin down:
 *
 *  - **It is a loop, not a step.** Demoting onto an EMPTY stack keeps V
 *    constant (pinned −1, stack gains its slot +1), so a single step can make
 *    no progress against C_min; the next iteration does. Convergence is by
 *    `pinned.length` strictly decreasing, bounded by the initial pin count.
 *  - **It stops rather than lying.** With no pins left, the loop exits with
 *    `exhausted: true` instead of dismantling the stack.
 *
 * Widening never auto-restores demoted pins (§5.3) — this function is called
 * with the new width and simply finds nothing to do.
 */
export function normalize(input: NormalizeInput): NormalizeResult {
  const stack = [...input.stack];
  const pinned = [...input.pinned];
  const demoted: EntityId[] = [];
  let widthCaused = false;
  let maxPinsCaused = false;

  for (;;) {
    const tooNarrow = input.centerWidth < cMin(panelSlots({ stack, pinned }));
    const tooManyPins = pinned.length > MAX_PINNED;
    if (!tooNarrow && !tooManyPins) {
      const cause = widthCaused && maxPinsCaused
        ? 'both'
        : widthCaused
          ? 'width'
          : maxPinsCaused
            ? 'max-pins'
            : null;
      return { stack, pinned, cause, demoted, exhausted: false };
    }
    widthCaused ||= tooNarrow;
    maxPinsCaused ||= tooManyPins;
    if (pinned.length === 0) {
      // C-3 exit state: nothing left to demote. The stack keeps its panel.
      const cause = widthCaused && maxPinsCaused
        ? 'both'
        : widthCaused
          ? 'width'
          : 'max-pins';
      return { stack, pinned, cause, demoted, exhausted: true };
    }
    // Oldest pin (pin order is left-to-right) lands on the stack TOP.
    // `p` is encoded bottom→top (§6), so the top is the array's end.
    const oldest = pinned.shift() as EntityId;
    stack.push(oldest);
    demoted.push(oldest);
  }
}

// ---------------------------------------------------------------------------
// The shrink-order solver (§5.1 / 02-LAYOUT §5)
// ---------------------------------------------------------------------------

/**
 * The stacking escalation drawn by the T1-3 canvas, reached only after the
 * center has bottomed out at its floor with no pins left to demote.
 */
export type PanelStackMode = 'columns' | 'right-stacked' | 'both-stacked' | 'sheets';

export interface SolveInput {
  /** Full window width available to the shell. */
  viewport: number;
  /** Is the server rail shown? Phase 1: hidden (R10 / SPEC-FINAL O-2 recommends S=0). */
  serverRail: boolean;
  /** User/persisted side-panel widths — shrunk toward the floors, never below. */
  leftWidth?: number;
  rightWidth?: number;
  /** Panel state, for C_min. */
  stack: readonly EntityId[];
  pinned: readonly EntityId[];
  /** Has the viewer collapsed the rail themselves (⌘\)? A manual collapse is never undone by the solver. */
  menuCollapsedByUser?: boolean;
  /**
   * `Σb` from the WLT §6 breakpoint equations — borders, scrollbars, resizers.
   * WLT is explicit that these constants are **DERIVED at reference capture by
   * measurement**, so this module refuses to bake a value in: callers pass what
   * they measured. It defaults to 0, which is honest (an unmeasured chrome
   * budget IS zero) and keeps the unit tests exercising the pure equations.
   * The D10 real-browser pass is where the real number arrives.
   */
  borders?: number;
}

export interface WorkspaceLayout {
  serverRail: typeof SERVER_RAIL_HIDDEN | typeof SERVER_RAIL_SHOWN;
  /** Discrete by law — M ∈ {48, 220}, never an interpolated width. */
  menu: typeof MENU_COLLAPSED | typeof MENU_EXPANDED;
  left: number;
  right: number;
  /** Space the center track actually gets, after the sides take theirs. */
  center: number;
  /** The floor that center must clear for the current V. */
  centerMin: number;
  stackMode: PanelStackMode;
  /** True when even `sheets` cannot honor every floor — the honest overflow state. */
  belowFloors: boolean;
}

/**
 * Applies the 02-LAYOUT §5 shrink order in sequence:
 *
 *   menu collapses → side panels to floors → (pins demote — see `normalize`,
 *   run by the caller against this result's `center`) → center bottoms at 320
 *   → panels stack (right-stacked → both-stacked → full-width sheets).
 *
 * Demotion is deliberately NOT folded in here: §5.3 makes it a reaction to a
 * MEASURED center width, so the caller solves tracks, measures, then
 * normalizes. Folding it in would make this function guess at a measurement.
 *
 * **Breakpoint constants are derived, never asserted** (§5.1). There is no
 * `@media (max-width: 1280px)` anywhere in this module or its stylesheet: the
 * states fall out of the floors. That is also why the tests assert ORDER and
 * TRANSITIONS rather than the pixel where each one flips — the flip points are
 * captured by measurement at the D10 real-browser pass.
 */
export function solveWorkspace(input: SolveInput): WorkspaceLayout {
  const serverRail = input.serverRail ? SERVER_RAIL_SHOWN : SERVER_RAIL_HIDDEN;
  const centerMin = cMinFor({ stack: input.stack, pinned: input.pinned });
  const borders = input.borders ?? 0;

  const wantLeft = Math.max(LEFT_PANEL_MIN, input.leftWidth ?? LEFT_PANEL_DEFAULT);
  const wantRight = Math.max(RIGHT_PANEL_MIN, input.rightWidth ?? RIGHT_PANEL_DEFAULT);

  /**
   * Center width left over, per the WLT §6 equations. A gap is spent only on a
   * side panel that is actually a COLUMN — right-stacked spends one gap,
   * both-stacked spends none. (That is why this counts gaps instead of always
   * subtracting `2 * GRID_GAP`.)
   */
  const centerFor = (menu: number, left: number, right: number): number => {
    const gaps = (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);
    return input.viewport - serverRail - menu - left - right - gaps * GRID_GAP - borders;
  };

  // Step 1 — the menu collapses first. A viewer who collapsed it by hand stays
  // collapsed; the solver never re-expands someone's rail underneath them.
  const menuStates = input.menuCollapsedByUser
    ? ([MENU_COLLAPSED] as const)
    : ([MENU_EXPANDED, MENU_COLLAPSED] as const);

  for (const menu of menuStates) {
    const center = centerFor(menu, wantLeft, wantRight);
    if (center >= centerMin) {
      return {
        serverRail, menu, left: wantLeft, right: wantRight, center, centerMin,
        stackMode: 'columns', belowFloors: false,
      };
    }
  }

  const menu = MENU_COLLAPSED;

  // Step 2 — side panels shrink toward their floors, sharing the deficit in
  // proportion to the slack each one actually has. Neither goes below its floor.
  const slackLeft = wantLeft - LEFT_PANEL_MIN;
  const slackRight = wantRight - RIGHT_PANEL_MIN;
  const slack = slackLeft + slackRight;
  const deficit = Math.max(0, centerMin - centerFor(menu, wantLeft, wantRight));
  const take = Math.min(deficit, slack);
  const fromLeft = slack > 0 ? Math.round((take * slackLeft) / slack) : 0;
  const left = wantLeft - fromLeft;
  const right = wantRight - (take - fromLeft);

  const center = centerFor(menu, left, right);
  if (center >= centerMin) {
    return { serverRail, menu, left, right, center, centerMin, stackMode: 'columns', belowFloors: false };
  }

  // Step 3 is the CALLER's `normalize` call — pins demote against the measured
  // center, which lowers C_min and may bring us back into `columns` on the next
  // solve. It is not folded in here (see the docblock).

  // Steps 4/5 — the center has bottomed out. Panels stack, handing the center
  // back one side column at a time (T1-3: right-stacked → both-stacked → sheets).
  const rightStacked = centerFor(menu, LEFT_PANEL_MIN, 0);
  if (rightStacked >= centerMin) {
    return {
      serverRail, menu, left: LEFT_PANEL_MIN, right: 0, center: rightStacked, centerMin,
      stackMode: 'right-stacked', belowFloors: false,
    };
  }

  const bothStacked = centerFor(menu, 0, 0);
  if (bothStacked >= centerMin) {
    return {
      serverRail, menu, left: 0, right: 0, center: bothStacked, centerMin,
      stackMode: 'both-stacked', belowFloors: false,
    };
  }

  // Sheets: the center is the whole width; panels present as full-width
  // overlays, one at a time. If even this cannot clear one panel column we say
  // so — `belowFloors` is the honest overflow admission, not a 200px "panel"
  // rendered as if it were a layout.
  return {
    serverRail, menu, left: 0, right: 0, center: bothStacked, centerMin,
    stackMode: 'sheets', belowFloors: bothStacked < PANEL_COL_MIN,
  };
}
