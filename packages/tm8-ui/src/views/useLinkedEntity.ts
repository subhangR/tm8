/**
 * `e/{id}` — DOES THE ENTITY THIS ADDRESS NAMES STILL EXIST?
 *
 * WHY A SEPARATE READ AT ALL. The Space opened, so nothing above this level
 * failed; the shell will happily draw the entity's origin screen with an empty
 * panel where the entity should be. That is the entity half of the same
 * dishonesty the Space refusal removes — a link that resolves to a screen the
 * sender never meant, with nothing saying the thing they linked to is gone.
 * `EntityUnavailableRefusal` is the answer, and it needs a fact to render from.
 *
 * THE CANONICAL READ, DELIBERATELY. `seam.entity` is the same `e/{id}` read the
 * route grammar names, so "the link 404s" is measured against exactly the thing
 * the link addresses — not inferred from a hydrated list, which is scoped to a
 * kind and a page and would report "absent" for rows that are merely elsewhere.
 *
 * TWO CODES MEAN GONE, AND A THIRD MEANS NOTHING:
 *   · `not_found` — deleted, purged, or never existed here.
 *   · `forbidden` — `visibility: 'restricted'`, which is INERT in v1: the RLS
 *     policy set (`db/migrations/008_rls_policies.sql`) grants no read to
 *     anybody, so a restricted row is unreadable BY EVERYONE. Rendering "this
 *     is unavailable" is the true sentence, and it is also the one that says
 *     nothing about who else can see it.
 *   · anything else — a transport failure, a 503, a node that blinked. That is
 *     NOT evidence the entity is dead and must never be drawn as a tombstone,
 *     so it resolves to `unreadable` and the shell renders what it would have
 *     rendered anyway. A card that says "deleted" about a node timeout is the
 *     same class of lie in the other direction.
 *
 * IT DRAWS NOTHING AND NAVIGATES NOWHERE. The recovery — the Space's safe
 * default view, as a history REPLACEMENT so Back cannot restore the broken URL
 * — belongs to the host, which owns the nav store. This only answers.
 */
import { useEffect, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { CollabError } from '@tm8/contract';
import type { Seam } from '../data/seam';

export type LinkedEntityState =
  /** The address names no entity, or the Space is not open yet. */
  | 'idle'
  /** The read is in flight. Nothing is claimed either way while this holds. */
  | 'checking'
  /** The node returned it. */
  | 'live'
  /** The node answered `not_found` or `forbidden`: the link has no destination. */
  | 'dead'
  /** The read failed for a reason that is not an answer about this entity. */
  | 'unreadable';

export interface UseLinkedEntityInput {
  seam: Seam;
  /** The open Space. Empty while boot has not settled one. */
  spaceId: SpaceId;
  /** The Space finished hydrating — before that a failed read proves nothing. */
  ready: boolean;
  /** The entity the ADDRESS names, or null for every other route. */
  entityId: EntityId | null;
}

export function useLinkedEntity(input: UseLinkedEntityInput): LinkedEntityState {
  const { seam, spaceId, ready, entityId } = input;
  const [state, setState] = useState<LinkedEntityState>('idle');

  useEffect(() => {
    if (!entityId || !spaceId || !ready) {
      setState('idle');
      return;
    }
    let cancelled = false;
    setState('checking');
    void (async () => {
      try {
        await seam.entity(entityId);
        if (!cancelled) setState('live');
      } catch (error: unknown) {
        if (cancelled) return;
        const code = error instanceof CollabError ? error.code : null;
        setState(code === 'not_found' || code === 'forbidden' ? 'dead' : 'unreadable');
      }
    })();
    return () => {
      cancelled = true;
    };
    /* KEYED ON THE SPACE TOO, not only the id. Entity ids are space-scoped, so
       the same id read against a different Space is a different question — and
       a stale `live` carried across a Space switch would suppress the tombstone
       for an address that genuinely has no destination here. */
  }, [seam, spaceId, ready, entityId]);

  return state;
}
