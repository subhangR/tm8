import type { ReactNode } from 'react';
import type { EntityId, EntityKind } from '@tm8/contract';
import type { CollectionMode } from '../../domain';
import { slugOfKind } from '../../domain';
import type { Origin } from '../../routes';
import { Z4Host } from '../../shell';
import type { EntityFullPort } from './port';

/**
 * EntityFullView — the route-facing component for `#/s/{spaceId}/e/{entityId}`
 * (ruling M1), and the landing place for a panel's promote ⤢.
 *
 * IT OWNS ROUTE-TO-STATE RESOLUTION AND NOTHING ELSE. Placement belongs to
 * `Z4Host`; anatomy belongs to `EntityDetailPanel`; the history write belongs to
 * the mount lane. What is left — and what had no home before this file — is the
 * question a shared link asks and an in-app promote never does: IS THERE AN
 * ENTITY THERE AT ALL, and if not, what may we say about it.
 *
 * WHY THE PANEL ARRIVES AS AN ELEMENT RATHER THAN AS PROPS. `EntityDetailPanel`
 * takes two required props and fifty-five optional ones, and the useful ones —
 * the four tabs' data, liveness, handoffs, authoring, the four injected surfaces
 * — are assembled inside `GateApp`. A second assembly in this directory would
 * not be the same panel; it would be a poorer one that drifts, which is the
 * exact failure the one-panel law exists to prevent. So Phase 2 passes the panel
 * in, already wired, already `host='z4'`, because Phase 2 is in the file where
 * those props already live. `Z4Host` made the same call for the same reason and
 * says so in its header: it "owns placement and nothing else".
 *
 * ── TWO CALLERS, TWO HISTORIES, ONE URL ────────────────────────────────────
 *
 * This is the part that does not surface as a crash. It gets reported as "the
 * back button is broken" and takes a week to trace, because both entry paths
 * produce the SAME address and opposite correct behaviours:
 *
 *   PASTED LINK, cold. `history.length === 1`. There is NOTHING behind the
 *   viewer, so the back affordance cannot mean BACK and can only mean UP. If up
 *   PUSHED, back would return to the entity and the viewer would be trapped in a
 *   two-item loop with no exit — on the exact entry path a shared link creates,
 *   which is the one path this whole lane exists for. R15 rules the first step
 *   up a REPLACE. The kind-screen case already implements it at
 *   `GateApp.tsx:545-573`, spending the replace ONCE through a `coldEntry` ref;
 *   every later navigation is an ordinary push.
 *
 *   PROMOTE from the workspace. Arrived BY A PUSH, with a live panel stack
 *   behind it. Back must behave the ordinary way, and collapsing returns the
 *   viewer to the companion they came from.
 *
 * The two are indistinguishable FROM THE ADDRESS. They are told apart only by
 * history depth at the moment of entry, which is readable only through the
 * transport and only then — which is why `arrival` is a prop and not something
 * this component sniffs.
 *
 * THIS COMPONENT DOES NOT WRITE HISTORY. `routes/*` and `stores/navStore.ts`
 * belong to the mount lane. But it does not dump the decision on the caller
 * either: it CARRIES the R15 rule as data, handing `onLeave` the history
 * discipline the step requires, so Phase 2 obeys a computed verdict instead of
 * re-deriving one. See `onLeave`.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *  - It never calls `setSpaceId`, and never falls back to "the first available
 *    Space". That is a live bug at `views/useGateData.ts:886`, and a deep-link
 *    feature whose failure mode is "you quietly land somewhere else" is worse
 *    than no deep links at all.
 *  - It never draws a control that cannot perform. No companion and no
 *    `onLeave` ⇒ no collapse affordance; `Z4Host` already omits its own button
 *    when `onCollapse` is absent, so this is one rule in one place.
 *
 * ON THE §9.2 SINGLE-HOST LAW: `Z4Host`'s header requires that Z4 not mount a
 * second copy of a panel also rendered in the centre. Today that holds
 * STRUCTURALLY rather than by enforcement — `GateApp`'s route arms are an
 * exclusive ternary chain, so the workspace centre is not mounted while
 * `view === 'entity'`. Nothing checks it. Stated, not enforced; see the report.
 */

/** Where the viewer came from. Not inferable from the address — see above. */
export type EntityArrival = 'link' | 'promote';

/** The collection screen this entity belongs to, when it has one. */
export interface EntityCompanion {
  readonly slug: string;
  readonly mode?: CollectionMode;
}

/** What a step away from the full view costs, computed here and written there. */
export interface EntityLeaveStep {
  /** Null ⇒ this kind has no collection screen. Not an error; see `companionOf`. */
  readonly destination: EntityCompanion | null;
  /**
   * R15. `replace` on the first step up from a COLD entry, so Back cannot
   * restore the address the viewer could not use; `push` for everything else.
   * Phase 2 spends the replace once and pushes thereafter.
   */
  readonly history: 'replace' | 'push';
}

export interface EntityFullViewProps {
  entityId: EntityId;
  /** From the route. Null on promote from the workspace — the common case. */
  origin?: Origin | null;
  /** How the viewer got here. Decides the history discipline, nothing else. */
  arrival: EntityArrival;
  port: EntityFullPort;
  /**
   * PROMOTE'S FAST PATH. On promote the entity is already loaded and on screen,
   * so a read to discover its kind would be a pointless round trip AND a visible
   * loading flash on a purely local action. Supply the known kind and the lookup
   * is skipped entirely. This is what lets one host serve both callers without
   * either paying the other's cost.
   */
  knownKind?: EntityKind | null;
  /** The wired `EntityDetailPanel`, rendered by the caller with `host='z4'`. */
  panel: ReactNode;
  /**
   * Leave the full view — collapse ⤡, or the unavailable card's recovery. Given
   * the destination and the history discipline that step requires. Omit it and
   * no affordance is drawn.
   */
  onLeave?: (step: EntityLeaveStep) => void;
  /**
   * The unavailable state's card. Phase 2 injects 1C's `EntityUnavailableRefusal`
   * (props: `{ onOpenSpace?: () => void }`). A slot rather than an import because
   * that component lands on a different branch and this directory must not reach
   * across the seam to it.
   */
  renderUnavailable?: (args: { entityId: EntityId; onRecover?: () => void }) => ReactNode;
  /** Registry-supplied immersive Z4; forwarded to `Z4Host` untouched. */
  immersive?: boolean;
}

/**
 * The companion screen to return to, by the §2.2 canonical-reload rule.
 *
 * `origin` names it outright when the link carried one. With no origin — every
 * promote, and any hand-typed `e/{id}` — the rule resolves it from the entity's
 * KIND, which is why this cannot be a pure function of the route and why
 * `landingOfRoute` correctly returns null there (`nav-targets.ts:247`) rather
 * than guessing.
 *
 * NULL IS A THIRD REAL ANSWER, NOT A FAILURE. `slugOfKind` returns null for the
 * 'special' and 'anchored' strategies (voice_channel, message), which have no
 * `k/` view BY DESIGN per WLT §2.1. Those kinds have nowhere to collapse TO —
 * which is a fact about the kind, not a broken link, and must not be rendered as
 * unavailable.
 */
export function companionOf(origin: Origin | null | undefined, kind: EntityKind | null): EntityCompanion | null {
  if (origin) {
    return origin.mode ? { slug: origin.slug, mode: origin.mode } : { slug: origin.slug };
  }
  if (!kind) return null;
  const slug = slugOfKind(kind);
  return slug ? { slug } : null;
}

export function EntityFullView({
  entityId,
  origin,
  arrival,
  port,
  knownKind,
  panel,
  onLeave,
  renderUnavailable,
  immersive,
}: EntityFullViewProps) {
  /* The promote fast path: a known kind IS the resolution, so no read runs. */
  const resolution = knownKind ? ({ status: 'ready', kind: knownKind } as const) : port.lookup(entityId);

  const kind = resolution.status === 'ready' ? resolution.kind : null;
  const companion = companionOf(origin, kind);

  /* R15 lives here, in one expression, rather than in each caller's head. */
  const leave = onLeave
    ? () => onLeave({ destination: companion, history: arrival === 'link' ? 'replace' : 'push' })
    : undefined;

  if (resolution.status === 'unavailable') {
    /*
     * THE ADDRESS IS KEPT. The link is still correct and still shareable; it is
     * only undrawable. Rewriting it here would destroy the one thing that still
     * works, and this component has no business writing the address anyway.
     *
     * The card is 1C's, injected. Nothing about WHY is available to pass it even
     * if it wanted to — the port cannot express the difference (see `port.ts`),
     * which is how R4 survives a second author.
     */
    return (
      <Z4Host entityId={entityId} immersive={immersive}>
        <div className="ev-root" data-testid="entity-full-view-unavailable">
          {renderUnavailable?.({ entityId, onRecover: leave })}
        </div>
      </Z4Host>
    );
  }

  if (resolution.status === 'resolving') {
    /*
     * Cold arrival only: on promote the entity was already on screen, so this
     * state is unreachable through that door. It is NOT the panel's own
     * `LoadingBody` — that one belongs to a panel we have decided to draw, and
     * here we do not yet know there is anything to draw. The difference matters
     * on a dead link, where the panel skeleton would promise an entity that is
     * never coming.
     */
    return (
      <Z4Host entityId={entityId} immersive={immersive}>
        <div className="ev-root" data-testid="entity-full-view-resolving" aria-busy="true">
          <span className="sr-only">Opening…</span>
        </div>
      </Z4Host>
    );
  }

  return (
    <Z4Host entityId={entityId} onCollapse={companion ? leave : undefined} immersive={immersive}>
      {panel}
    </Z4Host>
  );
}
