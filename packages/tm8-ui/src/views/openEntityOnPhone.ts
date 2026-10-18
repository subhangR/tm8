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
 * ── ONE PUSH, ONE ENTRY (t-nav, CONTRACT §5 rulings 1, 6, 7) ───────────────
 *
 * It used to navigate to the kind's list and then seed the stack, which the
 * gate's screen→URL sync turned into TWO history entries: the list, then the
 * entity. Back from an entity opened off a chat chip then landed on a list the
 * reader never saw instead of the transcript they tapped from. Now the kind
 * target carries the entity (`{ open }`), so the router writes the one address
 * `e/{id}?origin={slug}` and the gate's seed effect opens it on the stack.
 *
 * A link whose target is the entry directly below is Back, not a push (ruling
 * 6) — decided where history lives, in the gate's `navigateTo`.
 *
 * A kind with no `k/` screen (`slugOfKind` null: `message`, `voice_channel`)
 * opens the GENERIC ENTITY PAGE at its bare `e/{id}` (ruling 7), which replaces
 * the old "no phone screen" toast (audit E3). So every kind opens; the boolean
 * return is kept for callers written against the old contract and is always
 * true.
 *
 * THIS IS THE ONE PUSH. A chip in a transcript or strip (t-chips), an inbox
 * row, the drawer and the attention sheet all call it.
 */
import type { EntityId } from '@tm8/contract';
import { slugOfKind } from '../domain';
import type { MenuTarget } from '../shell';

/** The second argument of the gate's `navigateTo`. */
export interface NavigateOptions {
  /** Show this entity ON the target, as one address (one history entry). */
  readonly open?: EntityId;
}

export type PhoneNavigate = (target: MenuTarget, opts?: NavigateOptions) => void;

/**
 * Push `id`'s page onto the phone: its kind's screen with it open, or the
 * generic entity page for a kind with no list.
 */
export function openEntityOnPhone(navigateTo: PhoneNavigate, id: EntityId, kind: string): boolean {
  if (slugOfKind(kind)) navigateTo({ type: 'kind', ref: kind }, { open: id });
  else navigateTo({ type: 'entity', ref: id, kind }, { open: id });
  return true;
}
