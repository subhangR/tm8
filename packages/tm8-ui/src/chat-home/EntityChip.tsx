import { useEffect, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { KindIcon } from '../domain/KindIcon';
import { getKind } from '../domain/registry';
import { truncateEntityId, type ChatEntityRef } from './entity-refs';

/** Resolves a bare entity id to its kind/title — ChatHomeSurface builds this
 *  from `seam.entity`; fixture hosts may omit it entirely. */
export type ChatEntityResolver = (id: EntityId) => Promise<ChatEntityRef>;

/** Module-level resolution cache: one seam read per entity id per session,
 *  shared across every chip in every turn. Failures are NOT cached, so a
 *  later render retries; bounded as a leak guard. */
const resolutionCache = new Map<string, Promise<ChatEntityRef>>();
const CACHE_CAP = 200;

/** Test seam only. */
export function resetChatEntityResolutionCache(): void {
  resolutionCache.clear();
}

/** Shared with the entity graph (R7c): one read per id per session, whether
 *  the first asker was a chip or a graph card. */
export function resolveChatEntity(id: string, resolve: ChatEntityResolver): Promise<ChatEntityRef> {
  return resolveCached(id, resolve);
}

function resolveCached(id: string, resolve: ChatEntityResolver): Promise<ChatEntityRef> {
  const cached = resolutionCache.get(id);
  if (cached) return cached;
  if (resolutionCache.size >= CACHE_CAP) {
    const oldest = resolutionCache.keys().next().value;
    if (oldest !== undefined) resolutionCache.delete(oldest);
  }
  const promise = resolve(id as EntityId);
  resolutionCache.set(id, promise);
  promise.catch(() => resolutionCache.delete(id));
  return promise;
}

/**
 * EntityChip — a graph entity referenced by a tool call, rendered first-class:
 * the registry's kind mark, the title, and the kind word, clickable through to
 * the entity detail panel. With only an id in hand it shows the id truncated
 * and resolves the title lazily; resolution failure keeps the truncated id
 * (the chip stays clickable — the panel can still try the read itself).
 */
export function EntityChip({
  refInfo,
  resolve,
  onOpen,
}: {
  refInfo: ChatEntityRef;
  resolve?: ChatEntityResolver | undefined;
  onOpen?: ((id: EntityId) => void) | undefined;
}) {
  const [resolved, setResolved] = useState<ChatEntityRef | null>(null);
  const [failed, setFailed] = useState(false);
  const needsResolve = refInfo.title === undefined && resolve !== undefined;

  useEffect(() => {
    if (!needsResolve || resolve === undefined) return;
    let alive = true;
    resolveCached(refInfo.id, resolve).then(
      (ref) => {
        if (alive) setResolved(ref);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [needsResolve, refInfo.id, resolve]);

  const kind = refInfo.kind ?? resolved?.kind;
  const title = refInfo.title ?? resolved?.title;
  const state = title !== undefined ? 'resolved' : failed || !needsResolve ? 'unresolved' : 'pending';
  const body = (
    <>
      <span aria-hidden className="tch-entity-chip__icon">
        {kind ? <KindIcon kind={kind} size={12} /> : '◇'}
      </span>
      <span className="tch-entity-chip__title">{title ?? truncateEntityId(refInfo.id)}</span>
      <span className="tch-entity-chip__kind">{kind ? getKind(kind).label : 'entity'}</span>
    </>
  );

  return onOpen ? (
    <button
      type="button"
      className="tch-entity-chip"
      data-testid="chat-entity-chip"
      data-resolved={state}
      title={refInfo.id}
      onClick={() => onOpen(refInfo.id as EntityId)}
    >
      {body}
    </button>
  ) : (
    <span
      className="tch-entity-chip"
      data-testid="chat-entity-chip"
      data-resolved={state}
      title={refInfo.id}
    >
      {body}
    </span>
  );
}
