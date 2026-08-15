import type { EntityId, EntityKind } from '@tm8/contract';

/**
 * THE NARROW PORT `EntityFullView` READS THROUGH.
 *
 * The established idiom (see `views/channel-feed-port.ts`, `views/mergePrPort.ts`):
 * the feature directory declares the thin slice it needs, and an adapter on the
 * `views/` side maps the wide host object (`GateData`) onto it. That keeps this
 * directory pointing away from `views/`, and it keeps the seam read-only — this
 * component never touches the seam, the router or `setSpaceId`.
 *
 * WHY `unavailable` CARRIES NO REASON, AND WHY THAT IS A TYPE AND NOT A HABIT.
 *
 * A stranger holding a URL is the PROBING case. Telling them "not a member of
 * this space" CONFIRMS THE SPACE EXISTS — the exact disclosure R4 exists to
 * prevent. They arrived knowing nothing and would leave knowing one true fact
 * they had no right to.
 *
 * Someone whose ordinary boot restores a Space they were removed from ALREADY
 * KNEW it existed; they were in it. Withholding the reason THERE is not privacy,
 * it is unhelpfulness — which is why the ordinary boot card (`space-refusal-card`)
 * names the node's refusal verbatim and this one must not. Same refusal, two
 * audiences, and the distinguishing fact is whether the viewer arrived BY ADDRESS
 * or BY MEMORY. The next reader will see two similar cards and want to merge
 * them; that is the merge, and it would be wrong.
 *
 * So the port CANNOT EXPRESS the difference between "deleted", "never existed"
 * and "refused". Not "callers should not pass it" — there is no field to put it
 * in. R4 then stops depending on every future caller remembering the rule, which
 * is the only way a privacy rule survives contact with a second author.
 *
 * WHY `ready` CAN CARRY A NULL KIND, WHICH IS NOT THE SAME AS `unavailable`.
 *
 * The read that answers "is it there" can fail for a reason that is NOT an
 * answer about this entity — a 503, a node that blinked. `useLinkedEntity`
 * calls that `unreadable` and refuses to draw it as a tombstone, because a
 * card saying "deleted" about a node timeout is a lie in the other direction.
 * The honest rendering is the one the host would have drawn anyway: the panel,
 * which runs its own read and states its own failure. What is genuinely
 * missing is only the KIND — so the companion cannot be resolved, and a Z4
 * with no companion simply draws no collapse affordance (`companionOf`).
 *
 * So `ready` means "draw the entity", and a null kind means "and I could not
 * learn where it collapses to". Four states of one read stay distinct:
 * resolving · ready-with-kind · ready-without · unavailable.
 */
export type EntityResolution =
  | { readonly status: 'resolving' }
  | { readonly status: 'ready'; readonly kind: EntityKind | null }
  | { readonly status: 'unavailable' };

export interface EntityFullPort {
  /**
   * Resolve what is known about this entity RIGHT NOW — synchronous, from state
   * the host has already fetched. This is a projection, not a fetch: the adapter
   * owns the read and its lifecycle, exactly as `channelFeedPortFromGateData`
   * owns its slice. Returning `resolving` is how the adapter says "the read is
   * in flight", not a promise that one has been started.
   */
  lookup(entityId: EntityId): EntityResolution;
}
