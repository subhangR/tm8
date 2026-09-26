/**
 * "NEEDS ME" IS THE ATTENTION QUEUE (chapter 4 tab 8; spec-owner ruling on
 * S5b, msg 01a0dede-3172).
 *
 * The list filter keeps its place in the filter bar, but with an attention
 * module mounted its ROW SOURCE is `queue('mine')`'s roots, in queue order,
 * for this list's kind — never the server's old in-review-OR-mentions
 * predicate (G1, Q17), and never an intersection with the loaded page: the
 * list is paged on the server, so a root off the current page would silently
 * vanish. A root whose summary is not cached yet is pulled by id and appears
 * when it lands. Mine = 0 is the list's own empty state; there is no fallback
 * to "all".
 *
 * Outside a provider, or for any other filter, the host's source passes
 * through untouched.
 */
import type { EntitySummary } from '@tm8/contract';
import type { ListPageState } from '../domain/types';
import type { AttentionApi } from './index';

type Read<T> = (filter?: unknown, sort?: never) => T;

export interface NeedsMeData {
  detailOf(id: string): EntitySummary | undefined;
  pull?(id: string): void;
}

export function isNeedsMeFilter(filter: unknown): boolean {
  return (
    typeof filter === 'object' &&
    filter !== null &&
    typeof (filter as { needsActorId?: unknown }).needsActorId === 'string'
  );
}

/**
 * A pull is a fetch, and this runs in render: defer it past the render (the
 * same `queueMicrotask` discipline `useGateData.rowsFor` uses) and ask once
 * per id per host.
 */
const REQUESTED = new WeakMap<NeedsMeData, Set<string>>();
function requestPull(data: NeedsMeData, id: string): void {
  if (!data.pull) return;
  let seen = REQUESTED.get(data);
  if (!seen) {
    seen = new Set();
    REQUESTED.set(data, seen);
  }
  if (seen.has(id)) return;
  seen.add(id);
  queueMicrotask(() => data.pull?.(id));
}

/** The queue's roots of `kind`, in queue order, as the summaries the host holds. */
export function needsMeRows(api: AttentionApi, kind: string, data: NeedsMeData): readonly EntitySummary[] {
  const out: EntitySummary[] = [];
  for (const row of api.queue('mine')) {
    if (row.kind !== null && row.kind !== kind) continue;
    const summary = data.detailOf(row.rootId);
    if (summary) {
      if (summary.kind === kind) out.push(summary);
    } else {
      requestPull(data, row.rootId);
    }
  }
  return out;
}

/**
 * Wraps one kind's list source. Returns the three functions a list panel takes,
 * each deferring to the host's own unless the needs-me filter is active.
 */
export function needsMeListSource<RowsFn extends Read<readonly EntitySummary[]>, PageFn extends Read<ListPageState>, MoreFn extends Read<void>>(
  api: AttentionApi | null,
  kind: string,
  data: NeedsMeData,
  source: { rowsFor: RowsFn; pageStateOf: PageFn; loadMore: MoreFn },
): { rowsFor: RowsFn; pageStateOf: PageFn; loadMore: MoreFn } {
  if (!api) return source;
  const rowsFor = ((filter?: unknown, sort?: never) =>
    isNeedsMeFilter(filter) ? needsMeRows(api, kind, data) : source.rowsFor(filter, sort)) as RowsFn;
  const pageStateOf = ((filter?: unknown, sort?: never) =>
    isNeedsMeFilter(filter)
      ? { hasMore: false, loading: api.status === 'loading' }
      : source.pageStateOf(filter, sort)) as PageFn;
  const loadMore = ((filter?: unknown, sort?: never) => {
    if (!isNeedsMeFilter(filter)) source.loadMore(filter, sort);
  }) as MoreFn;
  return { rowsFor, pageStateOf, loadMore };
}
