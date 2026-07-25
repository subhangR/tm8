/**
 * Screen row — the ONE composition wrapper the L5 screens use when a list
 * needs something the collection layouts don't carry: a per-row screen action
 * (PULL), a facade-backed live badge row (RE-PULL), owner attribution, or a
 * selection checkbox for bulk ops.
 *
 * It renders NO entity markup of its own: the cell is `EntityCard` (Z2), the
 * badges are the live subsystem, the avatars are kit primitives. Everything
 * else is screen chrome around them.
 */
import type { ReactNode } from 'react';
import { EntityCard } from '../../entity';
import { Avatar } from '../../kit';
import { LiveBadges } from '../../subsystems/live';
import type { CollabFacade } from '../../facade/CollabFacade';
import type { ActorSummary, EntityId, EntitySummary } from '../../types/contract';
import { liveActorsOn } from './useViewerActors';

export interface EntityRowProps {
  entity: EntitySummary;
  onOpen: (id: EntityId) => void;
  /** Enables RE-PULL on the staleness badge. */
  facade?: CollabFacade;
  /** Screen affordance (PULL, refresh…), rendered beside the card. */
  action?: ReactNode;
  /** Extra meta line (owner attribution, space name…). */
  meta?: ReactNode;
  selected?: boolean;
  onToggleSelected?: (id: EntityId) => void;
}

export function EntityRow({
  entity, onOpen, facade, action, meta, selected, onToggleSelected,
}: EntityRowProps) {
  return (
    <div
      className="cv2-screenrow"
      data-entity={entity.id}
      data-selected={selected ? 'true' : undefined}
      data-testid={`row-${entity.id}`}
    >
      {onToggleSelected && (
        <input
          type="checkbox"
          className="cv2-screenrow__check"
          checked={Boolean(selected)}
          aria-label={`Select ${entity.title}`}
          onChange={() => onToggleSelected(entity.id)}
        />
      )}
      <div
        className="cv2-screenrow__cell"
        role="button"
        tabIndex={0}
        onClick={() => onOpen(entity.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(entity.id); }
        }}
      >
        <EntityCard entity={entity} />
      </div>
      <div className="cv2-screenrow__side">
        <LiveBadges entity={entity} facade={facade} compact />
        {meta}
        {action}
      </div>
    </div>
  );
}

/**
 * Owner attribution — an agent's work reads under the member it works for.
 * Pure kit avatars driven by `ActorSummary.ownerMemberId`.
 */
export function OwnerAttribution({ entity, actorsById }: {
  entity: EntitySummary;
  actorsById: Record<EntityId, ActorSummary>;
}) {
  const actors = liveActorsOn(entity);
  if (actors.length === 0) return null;
  return (
    <span className="cv2-screenrow__attrib" data-testid={`attrib-${entity.id}`}>
      {actors.map((actor) => {
        const owner = actor.ownerMemberId ? actorsById[actor.ownerMemberId] : undefined;
        return (
          <span key={actor.id} className="cv2-screenrow__attribpair">
            <Avatar actor={actor} size={18} />
            {owner && (
              <>
                <span className="cv2-screenrow__attribfor" aria-hidden="true">for</span>
                <Avatar
                  actor={owner}
                  size={18}
                  title={`${actor.displayName} works for ${owner.displayName}`}
                />
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}
