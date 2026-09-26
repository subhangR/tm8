/**
 * The attention-history section, composed ONCE for every host that mounts an
 * `EntityDetailPanel`.
 *
 * Same shape and the same reason as `debugSurface.tsx`: the panel layer is
 * presentational and never reaches for a seam, so the section has to arrive as
 * a node. Wiring five hosts by hand would fix five and leave the trap armed for
 * the sixth, so the composition lives here and a host opts in with one call.
 *
 * A HOST WITHOUT A SEAM GETS `undefined`, and the panel renders nothing at all
 * — which is the honest outcome here rather than a refusal card. Unlike Debug,
 * where a missing surface means a visible chip with nothing behind it, this
 * section is INVISIBLE on the overwhelming majority of entities anyway (it
 * hides when there is no history). There is no affordance left dangling, so
 * there is nothing to explain the absence of.
 *
 * WHERE IT MOUNTS is the panel's decision, not this file's, and it is not one
 * place: the content body for most archetypes, the Activity tab for the two
 * that own their own height (terminal, chat). See `EntityDetailPanel`.
 */
import type { ReactNode } from 'react';
import type { AttentionRequestMutationResult, EntityId, SpaceId } from '@tm8/contract';
import { AttentionRequests } from '../attention/AttentionRequests';
import { attentionPortFromSeam } from '../attention/port';
import type { Seam } from '../data/seam';

export function attentionSectionFor(
  seam: Seam | undefined,
  spaceId: SpaceId | string | null | undefined,
  entityId: string | null | undefined,
  /**
   * Fold a landed settlement into the host's store, so the tile's amber and the
   * top-bar count catch up — `data.reconcileCommand`, which already accepts an
   * `AttentionRequestMutationResult` and ingests its entity summary.
   *
   * THIS USED TO BE `() => data.pull?.(id)` AT ALL FIVE CALL SITES, and it was a
   * no-op every single time. `pull` FILLS a panel's cache and returns early when
   * the detail is already present — and on the panel showing this dock it always
   * is, because that cache is why the panel renders (see `useGateData.pull`). So
   * the write landed, the dock redrew, and the badge kept the stale number.
   * Reconciling from the summary the mutation already returned costs no request.
   */
  onSettled?: (result: AttentionRequestMutationResult) => void,
): ReactNode | undefined {
  if (!seam || !spaceId || !entityId) return undefined;
  return (
    <AttentionRequests
      // Keyed on the entity so switching entities remounts rather than showing
      // the previous one's history while the new fetch is in flight.
      key={entityId}
      entityId={entityId as EntityId}
      port={attentionPortFromSeam(seam, spaceId)}
      onSettled={onSettled}
    />
  );
}
