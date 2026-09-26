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
 * It is ONE FLAT LIST. The panel renders a single band from the needs-me clause
 * alone when it is active (tabs, sections, people chips and lenses do not
 * partition the queue), so this source only ever sees that clause.
 *
 * Outside a provider, or for any other filter, the host's source passes
 * through untouched.
 */
import type { EntitySummary } from '@tm8/contract';
import type { ListPageState } from '../domain/types';
import type { AttentionApi, AttentionQueueRow } from './index';

type Read<T> = (filter?: unknown, sort?: never) => T;

export interface NeedsMeData {
  detailOf(id: string): EntitySummary | undefined;
  pull?(id: string): void;
}

/** How long a pulled root may stay missing before the list stops saying "loading". */
export const PULL_PATIENCE_MS = 10_000;

export function isNeedsMeFilter(filter: unknown): boolean {
  return (
    typeof filter === 'object' &&
    filter !== null &&
    typeof (filter as { needsActorId?: unknown }).needsActorId === 'string'
  );
}

/**
 * When each root was first pulled, by id. Module-level on purpose: the host's
 * data object changes identity whenever its detail cache does, so keying on it
 * would re-ask on every landing. Ids are uuids, unique across spaces; `pull`
 * has its own in-flight guard, this only stops the render loop from re-asking
 * and records WHEN it asked, which is what `pending` reads.
 */
const PULLED = new Map<string, number>();

function requestPull(data: NeedsMeData, id: string, now: number): void {
  if (!data.pull || PULLED.has(id)) return;
  PULLED.set(id, now);
  // A pull is a fetch and this runs in render: defer it past the render (the
  // same `queueMicrotask` discipline `useGateData.rowsFor` uses).
  queueMicrotask(() => data.pull?.(id));
}

/** Test seam: forget which roots were pulled. */
export function resetNeedsMePulls(): void {
  PULLED.clear();
}

function mineOfKind(api: AttentionApi, kind: string): AttentionQueueRow[] {
  return api.queue('mine').filter((row) => row.kind === null || row.kind === kind);
}

/** The queue's roots of `kind`, in queue order, as the summaries the host holds. */
export function needsMeRows(
  api: AttentionApi,
  kind: string,
  data: NeedsMeData,
  now = Date.now(),
): readonly EntitySummary[] {
  const out: EntitySummary[] = [];
  for (const row of mineOfKind(api, kind)) {
    const summary = data.detailOf(row.rootId);
    if (summary) {
      if (summary.kind === kind) out.push(summary);
    } else {
      requestPull(data, row.rootId, now);
    }
  }
  return out;
}

/**
 * Whether the list is still honestly LOADING: the store has not answered, or a
 * mine root of this kind has no summary yet and was asked for recently. A root
 * that never lands (unreadable, deleted) stops counting after
 * `PULL_PATIENCE_MS`, and the panel's empty state then says how many it could
 * not show instead of "Nothing needs you".
 */
export function needsMeLoading(api: AttentionApi, kind: string, data: NeedsMeData, now = Date.now()): boolean {
  if (api.status === 'loading') return true;
  return mineOfKind(api, kind).some((row) => {
    if (data.detailOf(row.rootId)) return false;
    const asked = PULLED.get(row.rootId);
    return asked === undefined || now - asked < PULL_PATIENCE_MS;
  });
}

/** How many mine roots of this kind the queue names — for the honest empty state. */
export function needsMeCount(api: AttentionApi | null, kind: string): number {
  return api ? api.queue('mine').filter((row) => row.kind === kind).length : 0;
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
      ? { hasMore: false, loading: needsMeLoading(api, kind, data) }
      : source.pageStateOf(filter, sort)) as PageFn;
  const loadMore = ((filter?: unknown, sort?: never) => {
    if (!isNeedsMeFilter(filter)) source.loadMore(filter, sort);
  }) as MoreFn;
  return { rowsFor, pageStateOf, loadMore };
}
