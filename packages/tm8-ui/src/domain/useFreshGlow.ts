/**
 * The React face of `freshEntities`: what an item surface spreads on its root
 * so a just-created entity glows and a just-deleted one leaves (R40, R41).
 *
 * THE DELAY IS FIXED AT MOUNT. The fade is one CSS animation whose negative
 * `animation-delay` places a row that mounts mid-way at the right point of the
 * fade. Recomputing that delay on every render would shift a RUNNING
 * animation forward by the time already played, so the delay is taken once
 * per (mount, entry) and held.
 */
import { useCallback, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { freshEntities, type FreshEntityStore, type FreshEntry, type FreshPhase } from './freshEntities';

export interface FreshGlowAttrs {
  'data-fresh'?: '';
  'data-leaving'?: '';
  'aria-hidden'?: true;
  inert?: boolean;
  style?: CSSProperties;
}

export interface FreshGlow {
  phase: FreshPhase | null;
  /** Spread on the item's root element (merge `style` if the root has its own). */
  attrs: FreshGlowAttrs;
  /** Append to the item's accessible name while fresh, so "new" is not colour-only. */
  srSuffix: string | null;
}

const NONE: FreshGlow = Object.freeze({ phase: null, attrs: Object.freeze({}), srSuffix: null });
const NOOP_UNSUBSCRIBE = () => {};

export function useFreshGlow(
  id: string | null | undefined,
  store: FreshEntityStore = freshEntities,
): FreshGlow {
  const subscribe = useCallback(
    (listener: () => void) => (id ? store.subscribe(id, listener) : NOOP_UNSUBSCRIBE),
    [id, store],
  );
  const entry = useSyncExternalStore(subscribe, () => (id ? store.entryOf(id) : undefined));
  const delay = useRef<{ entry: FreshEntry; ms: number } | null>(null);
  if (entry && delay.current?.entry !== entry) {
    delay.current = { entry, ms: Math.max(0, store.now() - entry.startedAt) };
  }
  const delayMs = entry ? delay.current!.ms : 0;

  return useMemo(() => (entry ? glowOf(entry, delayMs) : NONE), [entry, delayMs]);
}

function glowOf(entry: FreshEntry, delayMs: number): FreshGlow {
  const style = { '--pn-fresh-delay': `-${Math.round(delayMs)}ms` } as CSSProperties;
  if (entry.phase === 'fresh') {
    return { phase: 'fresh', attrs: { 'data-fresh': '', style }, srSuffix: ', new' };
  }
  return {
    phase: 'leaving',
    attrs: { 'data-leaving': '', 'aria-hidden': true, inert: true, style },
    srSuffix: null,
  };
}

/**
 * `useFreshGlow` for a surface that draws many items inline (the graph canvas),
 * where a hook per item is not possible. Each entry's delay is fixed the first
 * time this surface sees it, for the same reason as above.
 */
export function useFreshGlowLookup(
  store: FreshEntityStore = freshEntities,
): (id: string) => FreshGlow {
  const version = useSyncExternalStore(store.subscribeAll, store.version);
  const seen = useRef(new WeakMap<FreshEntry, FreshGlow>());
  return useCallback(
    (id: string) => {
      const entry = store.entryOf(id);
      if (!entry) return NONE;
      let glow = seen.current.get(entry);
      if (!glow) {
        glow = glowOf(entry, Math.max(0, store.now() - entry.startedAt));
        seen.current.set(entry, glow);
      }
      return glow;
    },
    // `version` hands consumers a new function when any entry changes.
    [store, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** Merge the glow's style into a root that carries its own. */
export function withGlowStyle(style: CSSProperties | undefined, glow: FreshGlow): CSSProperties | undefined {
  if (!glow.attrs.style) return style;
  return style ? { ...style, ...glow.attrs.style } : glow.attrs.style;
}

/**
 * Keep a row that just vanished from `items` on screen while its entity is
 * leaving, at the place it held, so its exit can play. Everything else passes
 * through untouched; with nothing leaving this returns `items` itself.
 */
export function useRetainLeaving<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  store: FreshEntityStore = freshEntities,
): readonly T[] {
  const version = useSyncExternalStore(store.subscribeAll, store.version);
  const shown = useRef<readonly T[]>(items);
  const idOfRef = useRef(idOf);
  idOfRef.current = idOf;
  return useMemo(() => {
    const next = retainLeaving(shown.current, items, idOfRef.current, store);
    shown.current = next;
    return next;
    // `version` re-runs the merge when an exit ends.
  }, [items, version, store]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Pure merge behind `useRetainLeaving`. Exported for tests. */
export function retainLeaving<T>(
  previous: readonly T[],
  items: readonly T[],
  idOf: (item: T) => string,
  store: Pick<FreshEntityStore, 'isLeaving'>,
): readonly T[] {
  if (previous === items || previous.length === 0) return items;
  const present = new Set(items.map(idOf));
  const vanished = previous.filter((item) => !present.has(idOf(item)) && store.isLeaving(idOf(item)));
  if (vanished.length === 0) return items;
  const out = [...items];
  for (const item of vanished) {
    // Re-insert after the nearest earlier neighbour that is still shown.
    const at = previous.indexOf(item);
    let index = 0;
    for (let i = at - 1; i >= 0; i -= 1) {
      const neighbour = idOf(previous[i]!);
      const found = out.findIndex((x) => idOf(x) === neighbour);
      if (found >= 0) { index = found + 1; break; }
    }
    out.splice(index, 0, item);
  }
  return out;
}
