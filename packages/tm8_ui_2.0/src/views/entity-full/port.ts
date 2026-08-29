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
 */
export type EntityResolution =
  | { readonly status: 'resolving' }
  | { readonly status: 'ready'; readonly kind: EntityKind }
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
