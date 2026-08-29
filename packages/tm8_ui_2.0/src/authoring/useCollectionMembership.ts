import { useCallback, useState } from 'react';
import type {
  CollectionAddItemInput,
  CommandContext,
  CommandResult,
  EntityId,
  EntityKind,
  EntitySummary,
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
 * ONE HOOK, MANY SUBJECTS. The hook used to take a single `subjectId`, which
 * fit `EntityView`'s one open panel and nothing else: `WorkspaceView` renders
 * SEVERAL detail panels through one `renderPanel` callback, where a per-panel
 * hook call is illegal. So the handle is `authoringFor(subject)` — one hook
 * instance per host, one authoring object per rendered panel — and the
 * in-flight `pending` set is keyed by subject so panels cannot bleed spinners
 * into each other.
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
 * once rather than in every block instance or every host.
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

/** ONE panel's subject, as the registry's `membership` block declared it. */
export interface MembershipSubject {
  /** The entity whose panel hosts the block. */
  id: EntityId;
  /** Registry params off the declared `membership` block. */
  direction: 'outgoing' | 'incoming';
  /** Narrow the picker page to one kind (the entity side lists collections). */
  pickerKind: EntityKind | null;
  /**
   * Whether this subject's panel offers authoring at all. A REASON renders
   * the controls refused-but-focusable instead of hiding them (L6/D28).
   */
  refusal?: string | null;
}

export interface CollectionMembershipPort {
  commands: CollectionMembershipCommands;
  /** One bounded recent page for the picker; the block filters it by title. */
  searchPage(kind: EntityKind | null): Promise<EntitySummary[]>;
  /** Re-read the subject so the section reflects the write. */
  onChanged(subjectId: EntityId): void;
  onError(title: string, body: string): void;
}

export interface CollectionMembershipHandle {
  /** Pass to the host panel's `membershipAuthoring`. Null when unhosted. */
  authoringFor(subject: MembershipSubject | null): MembershipAuthoring | null;
}

export function useCollectionMembership(port: CollectionMembershipPort): CollectionMembershipHandle {
  const { commands, searchPage, onChanged, onError } = port;
  /** Peer ids in flight PER SUBJECT, so a row says so rather than looking
      inert — and so one panel's write never spins another panel's row. */
  const [pending, setPending] = useState<Readonly<Record<string, readonly string[]>>>({});

  const settle = useCallback((subjectId: string, peerId: string) => {
    setPending((current) => ({
      ...current,
      [subjectId]: (current[subjectId] ?? []).filter((id) => id !== peerId),
    }));
  }, []);

  const write = useCallback(
    (subject: MembershipSubject, verb: 'add' | 'remove', peerId: string, title: string) => {
      const subjectId = subject.id;
      const collectionId = subject.direction === 'outgoing' ? subjectId : (peerId as EntityId);
      const entityId = subject.direction === 'outgoing' ? (peerId as EntityId) : subjectId;
      setPending((current) => ({
        ...current,
        [subjectId]: [...(current[subjectId] ?? []), peerId],
      }));
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
          settle(subjectId, peerId);
        }
      })();
    },
    [commands, onChanged, onError, settle],
  );

  const authoringFor = useCallback(
    (subject: MembershipSubject | null): MembershipAuthoring | null => {
      if (!subject) return null;
      return {
        onAdd: (peerId, title) => write(subject, 'add', peerId, title),
        onRemove: (peerId, title) => write(subject, 'remove', peerId, title),
        search: () => searchPage(subject.pickerKind),
        refusal: subject.refusal ?? null,
        pending: pending[subject.id] ?? [],
      };
    },
    [pending, searchPage, write],
  );

  return { authoringFor };
}
