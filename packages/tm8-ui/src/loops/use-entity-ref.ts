import { useEffect, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';

/*
 * A NAME FOR AN ID A LOOP HOLDS — the runner, the subject, the tool. A
 * `LoopView` carries ids only; the list's Runs column and the page's WHAT IT
 * RUNS chips both need the title, so both read it here. One read per id per
 * seam (a list of twenty loops run by three teammates reads three entities).
 */

export interface LoopEntityRef { id: EntityId; kind: string; title: string }
export type LoopEntityRefState =
  | { status: 'none' }
  | { status: 'loading'; id: EntityId }
  | { status: 'ready'; ref: LoopEntityRef }
  | { status: 'missing'; id: EntityId; reason: string };

type EntityReader = Pick<Seam, 'entity'>;

/** How long a read title is trusted: long enough for one screen's rows to share it, short enough that a rename shows. */
export const ENTITY_REF_TTL_MS = 60_000;

const caches = new WeakMap<EntityReader, Map<string, { ref: Promise<LoopEntityRef>; at: number }>>();

/** The cached read behind the hook; a failed read is dropped so a later render may retry, and a stale one is read again. */
export function readEntityRef(seam: EntityReader, id: EntityId, now = Date.now()): Promise<LoopEntityRef> {
  let cache = caches.get(seam);
  if (!cache) caches.set(seam, cache = new Map());
  const held = cache.get(id);
  if (held && now - held.at < ENTITY_REF_TTL_MS) return held.ref;
  const ref = seam.entity(id).then(detail => ({ id, kind: detail.state.kind, title: detail.title }));
  const entry = { ref, at: now };
  ref.catch(() => { if (cache!.get(id) === entry) cache!.delete(id); });
  cache.set(id, entry);
  return ref;
}

export function useEntityRef(seam: EntityReader | null | undefined, id: EntityId | null | undefined): LoopEntityRefState {
  const [state, setState] = useState<LoopEntityRefState>(() => (id ? { status: 'loading', id } : { status: 'none' }));
  useEffect(() => {
    if (!id) { setState({ status: 'none' }); return; }
    if (!seam) { setState({ status: 'missing', id, reason: 'This view cannot read entities.' }); return; }
    let live = true;
    setState({ status: 'loading', id });
    readEntityRef(seam, id).then(
      ref => { if (live) setState({ status: 'ready', ref }); },
      (error: unknown) => {
        if (live) setState({ status: 'missing', id, reason: error instanceof Error ? error.message : 'Not readable.' });
      },
    );
    return () => { live = false; };
  }, [seam, id]);
  return state;
}

/** The words to draw for a ref state: the title, or a plain stand-in that never shows a raw id. */
export function entityRefLabel(state: LoopEntityRefState, fallback: string): string {
  if (state.status === 'ready') return state.ref.title || fallback;
  if (state.status === 'loading') return '…';
  if (state.status === 'missing') return `${fallback} (not visible)`;
  return fallback;
}
