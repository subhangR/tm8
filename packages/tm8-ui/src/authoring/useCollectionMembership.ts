import { useCallback, useMemo, useState } from 'react';
import type {
  CollectionAddItemInput,
  CommandContext,
  CommandResult,
  EntityId,
  EntityKind,
  EntitySummary,
  SpaceId,
} from '@tm8/contract';
import type { MembershipAuthoring } from '../panels/bodies/MembershipBlock';
import { nextMutationId } from './commands';

/**
 * AUTHORING COLLECTION MEMBERSHIP (`contains`, 001:921 / migration 100).
 *
 * The same intent/write split as `useMemoryWorkingSet`, and for the same
 * reason: no detail body in this tree mutates the graph. The `membership`
 * block raises intent (add this peer, remove that one) and this hook performs
 * the writes through the seam's membership pair.
 *
 * ONE HOOK, BOTH DIRECTIONS. The block serves a collection's ITEMS (outgoing)
 * and an entity's COLLECTIONS (incoming); which endpoint of the pair is "the
 * collection" therefore depends on the direction the registry declared:
 *
 *   outgoing — the SUBJECT is the collection; the picked peer is the member.
 *   incoming — the picked peer IS the collection; the subject is the member.
 *
 * Getting this wrong is not a cosmetic bug: `contains` runs collection →
 * entity and `validate_edge` refuses the reverse, so the mapping lives here
 * once rather than in every block instance.
 *
 * THE PICKER SEARCH IS ONE BOUNDED RECENT PAGE. `search.query` is reserved
 * (honest 501 forever), so there is no server text search to call. The hook
 * pages `collections.query` — recent first, optionally narrowed to the
 * `pickerKind` the registry declared — and the block filters that page by
 * title locally. The block's empty state says exactly this.
 */

export interface CollectionMembershipCommands {
  addToCollection(collectionId: EntityId, input: CollectionAddItemInput): Promise<CommandResult>;
  removeFromCollection(
    collectionId: EntityId,
    entityId: EntityId,
    ctx?: CommandContext,
  ): Promise<CommandResult>;
}

export interface CollectionMembershipPort {
  spaceId: SpaceId;
  /** The entity whose panel hosts the block. Null unhosts the hook. */
  subjectId: EntityId | null;
  /** Registry params off the declared `membership` block. */
  direction: 'outgoing' | 'incoming';
  /** Narrow the picker page to one kind (the entity side lists collections). */
  pickerKind: EntityKind | null;
  /**
   * Whether this subject's panel offers authoring at all. A REASON renders
   * the controls refused-but-focusable instead of hiding them (L6/D28).
   */
  refusal?: string | null;
  commands: CollectionMembershipCommands;
  /** One bounded recent page for the picker; the block filters it by title. */
  searchPage(kind: EntityKind | null): Promise<EntitySummary[]>;
  /** Re-read the subject so the section reflects the write. */
  onChanged(subjectId: EntityId): void;
  onError(title: string, body: string): void;
}

export interface CollectionMembershipHandle {
  /** Pass to the host panel's `membershipAuthoring`. Null when unhosted. */
  authoring: MembershipAuthoring | null;
}

export function useCollectionMembership(port: CollectionMembershipPort): CollectionMembershipHandle {
  const { spaceId, subjectId, direction, pickerKind, commands, searchPage, onChanged, onError } = port;
  void spaceId;
  /** Peer ids in flight, so a row says so rather than looking inert. */
  const [pending, setPending] = useState<readonly string[]>([]);

  const settle = useCallback((peerId: string) => {
    setPending((current) => current.filter((id) => id !== peerId));
  }, []);

  const write = useCallback(
    (verb: 'add' | 'remove', peerId: string, title: string) => {
      if (!subjectId) return;
      const collectionId = direction === 'outgoing' ? subjectId : (peerId as EntityId);
      const entityId = direction === 'outgoing' ? (peerId as EntityId) : subjectId;
      setPending((current) => [...current, peerId]);
      void (async () => {
        try {
          if (verb === 'add') {
            await commands.addToCollection(collectionId, {
              clientMutationId: nextMutationId(),
              entityId,
            });
          } else {
            await commands.removeFromCollection(collectionId, entityId, {
              clientMutationId: nextMutationId(),
            });
          }
          onChanged(subjectId);
        } catch (error) {
          const message = String((error as { message?: string })?.message ?? error);
          onError(
            verb === 'add' ? `“${title}” was not added` : `“${title}” was not removed`,
            message,
          );
        } finally {
          settle(peerId);
        }
      })();
    },
    [commands, direction, onChanged, onError, settle, subjectId],
  );

  const authoring = useMemo<MembershipAuthoring | null>(() => {
    if (!subjectId) return null;
    return {
      onAdd: (peerId, title) => write('add', peerId, title),
      onRemove: (peerId, title) => write('remove', peerId, title),
      search: () => searchPage(pickerKind),
      refusal: port.refusal ?? null,
      pending,
    };
  }, [pending, pickerKind, port.refusal, searchPage, subjectId, write]);

  return { authoring };
}
