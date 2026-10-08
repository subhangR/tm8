/** Lazy viewer counts, separate from entity admission and map lifecycle events. */
import type { SpaceUnreadCounts } from '@tm8/contract';
import type { MapInput } from '../story/game/map-model';
import type { Seam } from './seam';

/** Resolve counts first, then merge into the CURRENT input; never capture a map here. */
export type GameMailboxReader = ((signal?: AbortSignal) => Promise<SpaceUnreadCounts | null>) & {
  /** Local command completion. Durable cross-client refresh belongs to the event port. */
  onInvalidated?: (listener: (anchorId: string) => void) => () => void;
};

const MAILBOX_KINDS = new Set(['task', 'work_session', 'story']);
const UNAVAILABLE = 'Unread mailbox counts are unavailable; showing message counts or the last measured counts';
const INCOMPLETE = 'Unread mailbox counts reached their read budget; showing message counts or the last measured counts';

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Mailbox loading cancelled', 'AbortError');
}

export function createGameMailboxReader(seam: Pick<Seam, 'unreadCounts' | 'onReadMark'>, spaceId: string): GameMailboxReader {
  const reader: GameMailboxReader = async (signal) => {
    checkCancelled(signal);
    if (!seam.unreadCounts) return null;
    try {
      const get = () => { checkCancelled(signal); return seam.unreadCounts!(spaceId); };
      const snapshot = await (signal ? new Promise<SpaceUnreadCounts>((resolve, reject) => {
        const cancel = () => reject(new DOMException('Mailbox loading cancelled', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(get).then(
          (value) => { signal.removeEventListener('abort', cancel); if (!signal.aborted) resolve(value); },
          (error) => { signal.removeEventListener('abort', cancel); reject(error); },
        );
      }) : get());
      checkCancelled(signal);
      if (snapshot.spaceId !== spaceId || typeof snapshot.complete !== 'boolean' ||
        !Array.isArray(snapshot.counts) || snapshot.counts.some(row =>
          typeof row.anchorId !== 'string' || !Number.isSafeInteger(row.unread) || row.unread < 0)) return null;
      return snapshot;
    } catch (error) {
      checkCancelled(signal);
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return null;
    }
  };
  if (seam.onReadMark) reader.onInvalidated = listener => seam.onReadMark!(listener);
  return reader;
}

/**
 * Only primary-admitted anchors get counts. Incomplete snapshots are discarded
 * as a whole, including returned rows, so a partial subtree never supplies zeroes.
 */
export function applyGameMailboxCounts(input: MapInput, snapshot: SpaceUnreadCounts | null, spaceId: string): MapInput {
  const valid = snapshot?.spaceId === spaceId;
  const complete = valid && snapshot.complete;
  const counts = new Map(complete ? snapshot.counts.map(row => [row.anchorId, row.unread]) : []);
  const warnings = (input.warnings ?? []).filter(warning => warning !== UNAVAILABLE && warning !== INCOMPLETE);
  if (!complete) warnings.push(valid ? INCOMPLETE : UNAVAILABLE);
  return {
    ...input,
    warnings,
    entities: input.entities.map(entity => {
      if (!MAILBOX_KINDS.has(entity.kind) || (entity.spaceId && entity.spaceId !== spaceId)) return entity;
      return {
        ...entity,
        mailbox: complete ? { count: counts.get(entity.id) ?? 0, basis: 'unread' } : entity.mailbox ? {
          ...entity.mailbox,
          basis: entity.mailbox.basis ?? 'messages',
          // A failed refresh may retain an earlier measured count, never call it current.
          ...(entity.mailbox.basis === 'unread' ? { approx: true } : {}),
        } : undefined,
      };
    }),
  };
}
