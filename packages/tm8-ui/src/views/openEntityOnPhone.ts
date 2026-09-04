/**
 * `views/openEntityOnPhone.ts` — DEF-005. THE PHONE'S ANSWER TO "OPEN THIS".
 *
 * ── WHAT WAS WRONG, AND WHY IT SCORED AS FINE ───────────────────────────────
 *
 * `MobileShell` passed `InboxView` no `onOpenEntity`, deliberately and with a
 * docblock explaining it: `InboxScreen` checks whether the callback EXISTS and
 * renders its rows disabled-with-reason when it does not, so passing
 * `() => undefined` would have switched the honest state off and left every row
 * a live-looking control that swallowed the press. That reasoning is right and
 * it is kept.
 *
 * What it left behind is a screen that can show you a thing and then refuse to
 * open it — on one of the five destinations the tab bar promises. And the
 * instrument scored that screen a PASS: `results[surface=entity-detail-bare-
 * link].tapUnder44 = 0 of 6`, `inbox` clean apart from three `hon-disabled`
 * spans that RULE R2 correctly excludes. **Absence measures as health.** There
 * was nothing under 44px because there was nothing to press.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A HOOK ───────────────────────────────────
 *
 * `screenFor()` is a plain function called from `MobileShell`'s body, so a hook
 * inside it would be a conditional hook. Nothing here needs one: `navigateTo`
 * is already a prop, and the screen-stack store exposes an imperative
 * `getState()` that `GateApp` uses at exactly the same seam for the deep-link
 * case (`GateApp.tsx:657`).
 *
 * ── WHY IT REUSES THE STACK RATHER THAN INVENTING A ROUTE ───────────────────
 *
 * `mobile/index.ts` states the rule this obeys: "PUSH AND POP ARE NOT HERE, and
 * that absence is the point. Drilling in is
 * `useScreenStack(screenKeyOf.kind(k)).open(id)` and up is `.pop()` — the store
 * both shells already share. A `mobile/` push would be a second history model,
 * which `no-router-fork.test.ts` fails the build over and is right to."
 *
 * So this is a KIND NAVIGATION PLUS A STACK PUSH, which is the same pair the
 * gate's DEF-002 fix performs for a pasted `e/{id}` link. The header chevron
 * already pops it (CONTRACT.md §5) and `GateApp`'s step-up sync already writes
 * the address, so the opened entity is shareable and the back gesture is
 * honest — none of which had to be built here, and all of which would have had
 * to be built twice by a bespoke phone route.
 *
 * ── WHY IT TAKES A KIND AND DOES NOT LOOK ONE UP ────────────────────────────
 *
 * A kind screen's stack is keyed BY KIND (`screenKeyOf.kind`), so opening an
 * arbitrary id needs its kind, and `landingOfRoute`'s `entity` arm says why it
 * cannot supply one: "it needs the entity's kind, which is a read, so it cannot
 * be resolved here." Every caller this serves already holds it — an inbox row's
 * `target` is `{ id, kind, title }` (`inbox/inbox-model.ts:95`) — so the kind is
 * threaded rather than re-read. A caller that genuinely does not know the kind
 * must do the read; it must not guess.
 *
 * ── THE HONEST FAILURE, WHICH IS THE HALF THAT IS EASY TO SKIP ──────────────
 *
 * Not every kind HAS a `k/` screen. `slugOfKind` returns null for the `special`
 * and `anchored` strategies (`voice_channel`, `message`) — by design, WLT §2.1 —
 * and `routeViewOf` then returns null, so the navigation would produce no
 * address and the push would open a stack nobody can reach or share. RULE R13's
 * lesson exactly: a control that renders, presses, and does nothing.
 *
 * So this returns a BOOLEAN and the caller says so out loud. It does not
 * navigate halfway.
 */
import type { EntityId } from '@tm8/contract';
import { slugOfKind } from '../domain';
import type { MenuTarget } from '../shell';
import { screenKeyOf, screenStackStore } from '../stores/screenStackStore';

/**
 * Navigate the phone to `kind`'s screen and seed `id` onto its stack.
 *
 * @returns `false` when this kind has no phone screen to open the entity ON, in
 * which case NOTHING has been navigated and the caller must tell the reader.
 */
export function openEntityOnPhone(
  navigateTo: (target: MenuTarget) => void,
  id: EntityId,
  kind: string,
): boolean {
  /* The route check comes FIRST, before either half of the move. Navigating and
     then discovering there is no address would leave the reader on a kind
     screen they did not ask for with the thing they tapped not open — the
     "right collection, wrong outcome" state the gate's DEF-002 comment names. */
  if (!slugOfKind(kind)) return false;
  navigateTo({ type: 'kind', ref: kind });
  screenStackStore.getState().open(screenKeyOf.kind(kind), id);
  return true;
}
