/**
 * backContract — WHAT BACK MEANS, for both shells, in one place.
 *
 * ── THE CONFLICT THIS SETTLES ──────────────────────────────────────────────
 *
 * There is ONE browser history (`navStore` + the codec + one transport, per
 * "the shell forks and the router does not"). There is ALSO a `screenStackStore`
 * holding a SEPARATE per-screen drill-down stack, one per detail screen, keyed
 * by screen instance and deliberately not persisted.
 *
 * On a desktop those coexist without ever being asked to agree: the panel
 * column is visible, and Esc / the panel chrome pops the screen stack while the
 * browser's back button walks the address. Two gestures, two meanings, no
 * ambiguity. On a phone there is ONE surface and ONE back gesture, and it has
 * to mean exactly one thing.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 *     BACK ALWAYS WALKS THE BROWSER HISTORY. THE SCREEN STACK FOLLOWS IT.
 *
 * Back is never intercepted, on either shell. Nothing in this codebase listens
 * for `popstate` or for an Android back gesture, and nothing should: the phone's
 * back gesture IS browser back, and browser back already produces exactly the
 * right screen ONCE the screen stack is derived from the address rather than
 * merely seeded by it.
 *
 * WHY THAT IS NOT A DODGE OF THE QUESTION. Every screen-stack transition ALREADY
 * writes a browser history entry — `GateApp`'s screen→URL sync turns a drill-in
 * into a pushed `e/{id}?origin={slug}` and a step up into `k/{slug}`. So the
 * screen stack is not a second history; it is a PROJECTION of the one history,
 * and its depth is recoverable from the entries the walk passes through:
 *
 *     history:  #/s/S/k/tasks     #/s/S/e/A?origin=tasks   #/s/S/e/B?origin=tasks
 *     stack:    []                [A]                      [A, B]
 *
 * Walking that history backwards therefore POPS THE STACK, one rung per press —
 * which is observationally what MOBILE-DESIGN-BRIEF §6 proposes ("back pops the
 * stack"), reached without a second history model and without a back handler.
 * Choosing the other mechanism — pop the stack first, then write the URL to
 * match — would mean the stack LEADS on back and FOLLOWS on forward, and the two
 * directions would disagree the first time a viewer used the forward button or
 * pasted a link over a live stack. That disagreement is precisely "two history
 * models cannot agree about what BACK means", arrived at from the inside.
 *
 * ── WHAT WAS ACTUALLY BROKEN ───────────────────────────────────────────────
 *
 * The URL→stack direction was ONE-WAY: `GateApp`'s seed effect opens the entity
 * an address names and has no branch for an address that names none. So pressing
 * back from `e/A?origin=tasks` to `k/tasks` left `screenStackStore` still
 * holding `[A]`, the screen→URL sync in the same pass saw an open entity, and it
 * pushed `e/A` straight back. Back returned you to the entity you had just left,
 * and added a history entry doing it — a trap with no exit, on the exact entry
 * path a shared link creates. `router-mount.test.tsx`'s back/forward case walked
 * `workspace ↔ k/tasks` with no entity involved, so it never met this.
 *
 * This module supplies the missing half, and only that half.
 *
 * ── WHEN IT APPLIES: EXTERNAL ROUTE CHANGES ONLY ───────────────────────────
 *
 * `reconcileScreenStacks` is called from `attachRouter`'s inbound path, which
 * fires for back, forward, a pasted hash and a reload — and NOT for a store-led
 * navigation, which `applying`/`lastWritten` already filter out. That split is
 * the contract in one line:
 *
 *   - the viewer moved the STACK (tapped a row, tapped Esc)  → stack leads, URL follows
 *   - the viewer moved the ADDRESS (back, forward, paste)    → address leads, stack follows
 *
 * Both directions run through the same fixed point, so they settle in one pass
 * instead of pushing history at each other.
 *
 * ── THE FOUR QUESTIONS, ANSWERED TOGETHER ──────────────────────────────────
 *
 * The full contract, with the reasoning and the cross-device acceptance table,
 * is `docs/features/mobile/BACK-CONTRACT.md`. In short:
 *
 *   1. Back walks history; the stack follows. Nothing pops first.
 *   2. R15 composes trivially: an address carries AT MOST ONE entity, so a cold
 *      arrival cannot produce a stack deeper than 1. There is no several-deep
 *      stack to unwind on a link arrival, because nothing has been drilled yet.
 *   3. Closing the last item exits to the SCREEN ROOT (`k/{slug}`), never the
 *      app. `intentOfRoute` returns `clear` for a bare kind route, which is what
 *      makes that true rather than hoped-for.
 *   4. Back leaves the app exactly once, from the root of a cold link arrival,
 *      and returns the viewer to wherever the link came from. It never leaves
 *      the Space — `setSpace` writes with `replace`, so no space boundary the
 *      viewer did not walk is ever in the back stack.
 */
import type { EntityId } from '@tm8/contract';
import { landingOfRoute } from '../domain';
import type { NavView } from '../routes/types';
import { screenKeyOf, screenStackStore, type ScreenKey } from './screenStackStore';

/**
 * What ONE address says about ONE screen's stack.
 *
 * Deliberately an inert value rather than a call: the decision is the part that
 * has to be provably right, and a pure function of a `NavView` can be tested
 * exhaustively without a DOM, a store or a router — the same split
 * `shell-for.ts`/`useShellKind.ts` already uses for the shell fork.
 */
export type ScreenStackIntent =
  /** The address names an entity ON a screen: that screen shows it. */
  | { readonly kind: 'open'; readonly key: ScreenKey; readonly entity: EntityId }
  /** The address names a BARE screen: that screen is at its root. */
  | { readonly kind: 'clear'; readonly key: ScreenKey }
  /** The address names nothing that hosts a stack. Leave every stack alone. */
  | { readonly kind: 'none' };

const NONE: ScreenStackIntent = { kind: 'none' };

/**
 * Address → the active screen's stack. Total over `NavView`.
 *
 * KEYED TO THE ACTIVE SCREEN AND NO OTHER, which is what lets `screenStackStore`
 * keep doing its original job. Landing on `k/channels` says nothing about what
 * the Tasks screen has open, so the Tasks stack survives untouched and coming
 * back to it still restores what you were looking at. An address is a statement
 * about ONE screen, and reading it as a statement about all of them would delete
 * the store's whole reason to exist.
 *
 * `none` FOR AN UNRESOLVABLE ROUTE, not `clear`. `landingOfRoute` returns null
 * for a slug naming no registered kind and for a bare `e/{id}` with no `origin`
 * — links the shell surfaces as a refusal. A refusal must not ALSO destroy the
 * state the viewer had; wiping a stack on the way to an error card would turn
 * one bad link into lost context.
 */
export function intentOfRoute(view: NavView): ScreenStackIntent {
  const landing = landingOfRoute(view);
  if (!landing) return NONE;
  /* Only a kind screen hosts a stack today. `landingOfRoute` produces an
     `openEntity` for the `entity` route alone and that route's target is always
     a kind, so this narrows rather than assumes — and a future stack-hosting
     screen fails this check loudly instead of being silently mis-keyed. */
  if (landing.target.type !== 'kind') return NONE;
  const key = screenKeyOf.kind(landing.target.ref);
  return landing.openEntity ? { kind: 'open', key, entity: landing.openEntity } : { kind: 'clear', key };
}

/**
 * Apply an intent to `screenStackStore`.
 *
 * `open` REBUILDS THE STACK LOSSLESSLY, and that is a property of the store's
 * existing semantics rather than anything added here. `open` truncates on
 * revisit — opening A over `[A, B]` yields `[A]`, not `[A, B, A]` — so walking
 * back through `e/B → e/A → k/tasks` reconstructs `[A, B] → [A] → []`, and
 * walking forward again reconstructs `[] → [A] → [A, B]`. The stack a viewer
 * built is recovered exactly, in both directions, from the addresses alone.
 *
 * Every branch is a no-op when the store already agrees (`open` returns early
 * on an unchanged top, `clear` on an absent key), so an inbound hash that
 * changed nothing about the stack notifies no subscriber and triggers no render.
 * That is what keeps this out of the settle loop.
 */
export function applyScreenStackIntent(intent: ScreenStackIntent): void {
  const store = screenStackStore.getState();
  switch (intent.kind) {
    case 'open':
      store.open(intent.key, intent.entity);
      return;
    case 'clear':
      store.clear(intent.key);
      return;
    case 'none':
      return;
  }
}

/**
 * THE SEAM `attachRouter` CALLS. One line at the inbound path, so that the
 * address leading the stack is a property of the router loop rather than of any
 * one shell — which is the only way two shells can share the answer.
 */
export function reconcileScreenStacks(view: NavView): void {
  applyScreenStackIntent(intentOfRoute(view));
}
