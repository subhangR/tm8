/**
 * THE ROW-QUERY CACHE'S BOUND — and why the entity cap was unreachable without
 * one.
 *
 * `useGateData` keys one `RowPage` per (kind, filter, sort) triple, and until
 * this module existed nothing ever removed one inside a space's lifetime. Two
 * things follow from that, and the second is the one that matters:
 *
 *  1. The map itself grows. Every tier chip, every sort the viewer tries, every
 *     board filter, every panel a route mounts is a new permanent key holding
 *     up to a page of ids.
 *
 *  2. **It pinned the entity cache open.** `retainedEntityIds` is built from
 *     `Object.values(rows).flatMap(page => page.ids)` — so an id any read ever
 *     returned was retained FOREVER, and `enforceCacheBounds` skips retained
 *     ids. Once the union of every list the viewer had visited passed
 *     `ENTITY_CACHE_CAP`, the sweep could no longer find a single evictable
 *     entity and `entities` grew without limit for the rest of the session
 *     while the cap looked enforced. A cap whose protected set is unbounded is
 *     not a cap. Bounding the rows is therefore not a second optimisation on
 *     top of the entity cap — it is the precondition for it.
 *
 * RECENCY IS ACCESS ORDER, NOT WRITE ORDER. A list the viewer keeps looking at
 * is read from render every frame and written once, at hydration; a one-shot
 * read that nobody has looked at since is written just as recently. Evicting by
 * write order would drop the visible list and keep the forgotten one. So reads
 * stamp a ledger and writes consult it.
 *
 * THE LEDGER IS A REF, NEVER STATE. `rowsFor` runs during render, and stamping
 * React state from render is a re-render loop. A plain mutable Map has no such
 * hazard: nothing subscribes to it, it is read only at write time, and a
 * stamp lost to a discarded StrictMode render costs at most one key's recency.
 */
import type { EntityId } from '@tm8/contract';

/**
 * How many distinct (kind, filter, sort) reads a space keeps.
 *
 * Sized against what one screen can genuinely reference at once, not against
 * what feels safe: the workspace mounts two panels, Home reads three lists, the
 * palette one, and a board's filter rail can arm a handful more — call it a
 * dozen live keys in the worst arrangement this shell can render. 64 leaves
 * five times that headroom, so eviction only ever reaches keys belonging to
 * screens the viewer has left, while still bounding a session that browses all
 * day at a few thousand retained ids rather than every id in the space.
 */
export const ROW_QUERY_CACHE_CAP = 64;

/** Same shape as `useGateData`'s `RowPage`, structurally — this module only
    ever needs the ids, so it is deliberately not coupled to the rest. */
export interface CachedRows {
  readonly ids: readonly EntityId[];
}

/**
 * Access-order ledger over cache keys. Deliberately not a class and not
 * reactive: `touch` is called from render.
 */
export interface RecencyLedger {
  /** Record a use of `key`. Safe to call from render. */
  touch(key: string): void;
  /** Forget a key — after it is evicted, or when the whole cache resets. */
  forget(key: string): void;
  clear(): void;
  /** Test/diagnostic view: keys least-recently-used first. */
  order(): readonly string[];
}

export function createRecencyLedger(): RecencyLedger {
  // A Map's own iteration order is insertion order, so delete-then-set IS the
  // access-order list and no counter or sort is needed.
  const used = new Map<string, true>();
  return {
    touch(key) {
      used.delete(key);
      used.set(key, true);
    },
    forget(key) {
      used.delete(key);
    },
    clear() {
      used.clear();
    },
    order() {
      return [...used.keys()];
    },
  };
}

/**
 * Which keys to drop so `cap` remain, least-recently-used first.
 *
 * `pinned` is the set that must survive regardless of age — the keys with a
 * page read in flight. Evicting one of those would delete the base page an
 * append is about to extend, and the appended page would then render rows
 * 51-100 with nothing before them.
 *
 * A key the ledger has never seen sorts OLDEST: it was written and never read,
 * which is precisely the eviction candidate the write-order scheme could not
 * express. Keys are otherwise dropped in ledger order, and a cache that cannot
 * reach `cap` without evicting a pinned key simply stays over it — the bound is
 * best-effort against what the screen still references, exactly as
 * `enforceCacheBounds` is.
 */
export function rowKeysToEvict(
  keys: readonly string[],
  ledger: RecencyLedger,
  cap: number = ROW_QUERY_CACHE_CAP,
  pinned: ReadonlySet<string> = new Set(),
): string[] {
  let excess = keys.length - cap;
  if (excess <= 0) return [];
  const present = new Set(keys);
  const order = ledger.order();
  const known = new Set(order);
  const ranked = [
    // Never-read keys first, in the order the cache itself holds them.
    ...keys.filter((key) => !known.has(key)),
    ...order.filter((key) => present.has(key)),
  ];
  const out: string[] = [];
  for (const key of ranked) {
    if (excess <= 0) break;
    if (pinned.has(key)) continue;
    out.push(key);
    excess -= 1;
  }
  return out;
}

/**
 * Apply an eviction to a rows record, returning a NEW record — or the same one
 * when nothing was dropped, so an under-cap write never churns the identity
 * every downstream memo depends on.
 *
 * `onEvict` is how the caller releases the sibling bookkeeping that is keyed by
 * the same string. In `useGateData` that is the lifetime read CLAIM: a key
 * evicted while still claimed would return `EMPTY_ROWS` from `rowsFor` and
 * never re-read, because the claim is what suppresses the re-request. An
 * evicting cache without that callback trades an unbounded map for permanently
 * empty lists, which is the worse bug.
 */
export function evictRowKeys<T extends CachedRows>(
  rows: Readonly<Record<string, T>>,
  ledger: RecencyLedger,
  cap: number = ROW_QUERY_CACHE_CAP,
  pinned: ReadonlySet<string> = new Set(),
  onEvict?: (key: string) => void,
): Readonly<Record<string, T>> {
  const stale = rowKeysToEvict(Object.keys(rows), ledger, cap, pinned);
  if (stale.length === 0) return rows;
  const next = { ...rows };
  for (const key of stale) {
    delete next[key];
    ledger.forget(key);
    onEvict?.(key);
  }
  return next;
}
