/**
 * THE VIEW-REF CLASSIFICATION — WHAT THIS BUILD ACTUALLY HAS A SCREEN FOR.
 *
 * MOVED OUT OF `GateApp.tsx` BY THE SHELL CONTRACT (DEF-012), and the move is
 * the fix rather than tidying.
 *
 * The phone's refusal card said "This link still works on a desktop — nothing
 * about it is broken" for EVERY default-arm route, while this table classified
 * `feed` as `unbuilt`. So on `feed` the shell's own honesty mechanism was
 * lying: it sent a reader to a desktop to look for a screen that is not there
 * either. "Not built for this screen size" and "does not exist anywhere" are
 * different statements — the card's own comment says so — and the card was
 * making the first one about a route that is the second.
 *
 * The card could not read the classification because the classification lived
 * inside the module that renders the DESKTOP shell, and `MobileShell` is
 * imported BY that module — so reading it from there would have been a cycle.
 * A shared fact needs a home that both renderings can import, which is this
 * file. Both now derive their copy from one table instead of one deriving it
 * and the other asserting it.
 *
 * `satisfies Record<MenuViewRef, …>` is kept, and it is the load-bearing part:
 * a ref ADDED to the contract is a compile error here until somebody says which
 * of the three things it is. The failure being designed out is a new member
 * falling through to a default, so the default has to stop existing.
 */
import type { MenuViewRef } from '@tm8/contract';

export const VIEW_REF_SCREENS = {
  dashboard: 'mounted',
  inbox: 'mounted',
  graph: 'mounted',
  files: 'mounted',
  settings: 'mounted',
  git: 'mounted',
  messages: 'mounted',
  /* The task Board (2026-08-16): the kanban screen, mounted below. */
  board: 'mounted',
  /* The Craft studio (2026-08-16): the blueprint split pane, mounted below. */
  craft: 'mounted',
  /* Help (2026-08-19): the shelf and reader, mounted below AND on the phone —
     it is one of the few screens with a stacked arrangement, so it never
     reaches the refusal card. */
  help: 'mounted',
  workspace: 'workspace',
  /* The last genuinely unbuilt view ref. */
  feed: 'unbuilt',
  /* NOT unbuilt — an ALIAS, and as of the router mount this row is UNREACHABLE.
     `domain/nav-targets.ts` resolves `channels` to the `channel`-kind
     EntityView, which is mounted and always has been. Phase 0.5 classified it
     `unbuilt` because that is what the chain did with it then, and left the
     resolution to "the router mount, which owns both directions" — this is that
     mount, and both directions now resolve it. `routeViewOf` turns the alias
     into `k/channels` on the way out, so it never becomes an `unroutableTarget`;
     `landingOfRoute` turns it into the kind target on the way back in, so it is
     never what `activeTarget` derives to. Nothing can reach this row.

     KEPT ANYWAY, and not as clutter: the table is `satisfies
     Record<MenuViewRef, …>`, so every ref must be classified or the file does
     not compile — which is the property that makes a NEW ref a build failure
     rather than a silent fallthrough. Deleting an unreachable row would trade
     that guarantee for tidiness. */
  channels: 'unbuilt',
} as const satisfies Record<MenuViewRef, 'mounted' | 'unbuilt' | 'workspace'>;

/** `true` when this build has no screen for the ref and should say so. */
export function isUnbuiltViewRef(ref: string): boolean {
  return VIEW_REF_SCREENS[ref as MenuViewRef] === 'unbuilt';
}
