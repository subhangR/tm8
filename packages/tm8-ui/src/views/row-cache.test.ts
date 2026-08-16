/**
 * The row-query cache's bound, and the two ways an eviction can be wrong.
 *
 * The bound itself is the boring half. The interesting half is that this cache
 * has SIBLING BOOKKEEPING keyed by the same string — the lifetime read claim —
 * and dropping a page without releasing its claim produces a list that renders
 * empty forever, which is strictly worse than the unbounded map it replaced.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import {
  ROW_QUERY_CACHE_CAP,
  createRecencyLedger,
  evictRowKeys,
  rowKeysToEvict,
} from './row-cache';

const page = (...ids: string[]) => ({ ids: ids as EntityId[] });

function cacheOf(count: number): Record<string, { ids: readonly EntityId[] }> {
  const out: Record<string, { ids: readonly EntityId[] }> = {};
  for (let i = 0; i < count; i++) out[`k${i}`] = page(`e${i}`);
  return out;
}

describe('createRecencyLedger', () => {
  it('orders by ACCESS, not by first sight', () => {
    const ledger = createRecencyLedger();
    ledger.touch('a');
    ledger.touch('b');
    ledger.touch('c');
    ledger.touch('a');
    expect(ledger.order()).toEqual(['b', 'c', 'a']);
  });

  it('forgets a key', () => {
    const ledger = createRecencyLedger();
    ledger.touch('a');
    ledger.forget('a');
    expect(ledger.order()).toEqual([]);
  });
});

describe('rowKeysToEvict', () => {
  it('evicts nothing while under cap', () => {
    const ledger = createRecencyLedger();
    expect(rowKeysToEvict(['a', 'b'], ledger, 4)).toEqual([]);
  });

  it('evicts the LEAST RECENTLY USED, not the least recently written', () => {
    // The defect a write-order queue would have: `a` was written first but is
    // the list on screen, and `c` is a one-shot nobody has looked at since.
    const ledger = createRecencyLedger();
    ledger.touch('a');
    ledger.touch('b');
    ledger.touch('c');
    ledger.touch('a');
    expect(rowKeysToEvict(['a', 'b', 'c'], ledger, 2)).toEqual(['b']);
  });

  it('treats a never-read key as the oldest of all', () => {
    // Written by a read that resolved and was never rendered — exactly the
    // candidate a write-order scheme cannot express.
    const ledger = createRecencyLedger();
    ledger.touch('read');
    expect(rowKeysToEvict(['read', 'never'], ledger, 1)).toEqual(['never']);
  });

  it('skips a pinned key and takes the next candidate instead', () => {
    const ledger = createRecencyLedger();
    ledger.touch('a');
    ledger.touch('b');
    ledger.touch('c');
    expect(rowKeysToEvict(['a', 'b', 'c'], ledger, 2, new Set(['a']))).toEqual(['b']);
  });

  it('stays over cap rather than evict a pinned key', () => {
    // A page read in flight: evicting its base page would leave the appended
    // page rendering rows 51-100 with nothing before them.
    const ledger = createRecencyLedger();
    ledger.touch('a');
    ledger.touch('b');
    expect(rowKeysToEvict(['a', 'b'], ledger, 1, new Set(['a', 'b']))).toEqual([]);
  });
});

describe('evictRowKeys', () => {
  it('returns the SAME object when nothing is evicted', () => {
    // Identity matters: every downstream memo in `useGateData` keys off it, so
    // an under-cap write that churned the reference would re-run them all.
    const ledger = createRecencyLedger();
    const rows = cacheOf(3);
    expect(evictRowKeys(rows, ledger, 8)).toBe(rows);
  });

  it('bounds the cache and forgets what it dropped', () => {
    const ledger = createRecencyLedger();
    const rows = cacheOf(ROW_QUERY_CACHE_CAP + 5);
    for (const key of Object.keys(rows)) ledger.touch(key);

    const next = evictRowKeys(rows, ledger);
    expect(Object.keys(next)).toHaveLength(ROW_QUERY_CACHE_CAP);
    expect(next['k0']).toBeUndefined();
    expect(next[`k${ROW_QUERY_CACHE_CAP + 4}`]).toBeDefined();
    // The ledger must shrink with the cache, or it becomes its own leak.
    expect(ledger.order()).toHaveLength(ROW_QUERY_CACHE_CAP);
  });

  it('RELEASES THE CLAIM for every key it drops', () => {
    // The bug this callback exists to prevent: `rowsFor` returns EMPTY_ROWS for
    // an uncached key and only schedules a re-read if the key is UNCLAIMED. An
    // eviction that left the claim behind would make that list permanently
    // empty and permanently silent.
    const ledger = createRecencyLedger();
    const rows = cacheOf(3);
    for (const key of Object.keys(rows)) ledger.touch(key);
    const released: string[] = [];

    evictRowKeys(rows, ledger, 1, new Set(), (key) => released.push(key));
    expect(released).toEqual(['k0', 'k1']);
  });

  it('does not mutate the input record', () => {
    const ledger = createRecencyLedger();
    const rows = cacheOf(3);
    for (const key of Object.keys(rows)) ledger.touch(key);
    evictRowKeys(rows, ledger, 1);
    expect(Object.keys(rows)).toHaveLength(3);
  });

  it('bounds a session that browses forever', () => {
    // The end-to-end claim: every new (kind, filter, sort) the viewer visits is
    // a permanent key today, and `retainedEntityIds` unions every id in every
    // one of them — which is what made ENTITY_CACHE_CAP unreachable. After N
    // visits the map is still capped, so the retained set is too.
    const ledger = createRecencyLedger();
    let rows: Record<string, { ids: readonly EntityId[] }> = {};
    for (let i = 0; i < ROW_QUERY_CACHE_CAP * 10; i++) {
      const key = `kind::filter${i}::sort`;
      ledger.touch(key);
      rows = evictRowKeys({ ...rows, [key]: page(`e${i}`) }, ledger) as typeof rows;
    }
    expect(Object.keys(rows)).toHaveLength(ROW_QUERY_CACHE_CAP);
    const retained = new Set(Object.values(rows).flatMap((p) => p.ids));
    expect(retained.size).toBe(ROW_QUERY_CACHE_CAP);
  });
});
