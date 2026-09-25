/**
 * The block's one data hook: the form (the entity detail the host handed us,
 * or a newer one this hook fetched or a write returned), the viewer's slot and
 * the current responses — all through the seam, re-read when the port says
 * the form changed.
 *
 * THE DETAIL IS REFETCHED on a form upsert: the event (and any list-shaped
 * row the host may hold) carries only `{status, questionCount}`, never the
 * questions, so the block cannot rebuild itself from it.
 *
 * DELIVERY SETTLING EMITS NO EVENT (W4 risk), so while a delivery this block
 * shows is PENDING it reloads on an upsert of that delivery's work session
 * (a running/idle transition is when queued rows drain) and, as the backstop,
 * polls the responses every `DELIVERY_POLL_MS` while the page is visible. The
 * poll stops once nothing is pending.
 *
 * RESPONSES PAGE (keyset, newest first). "Load more" appends the next page.
 * A reload re-walks from the top THROUGH the oldest row the reader loaded, so
 * a live event never collapses their pages back to page 1, a new submission
 * never pushes a loaded row out of view, and a superseded row drops out.
 *
 * A FRESH delivery (pending, never attempted, inside `DELIVERING_GRACE_MS` of
 * its submit: delivery.ts) usually settles through the server's fast path in
 * a second or two, so while one is shown the block re-reads sooner, at the
 * `DELIVERY_FAST_POLL_MS` backoff (visible only), and the backstop stands
 * aside until that burst ends. A new fresh row (this viewer's submit, or one
 * a `responses` change brought in) starts a new burst. This viewer's own
 * submit time (`markSubmitted`) also dates their row, so a server clock
 * behind the browser's cannot age it out early.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DELIVERING_GRACE_MS, deliveryStart } from './delivery';
import { FormsPortError, formContentOf, useFormsPort, type FormResponseView, type FormState, type MyFormSlot } from './seam';

export { formContentOf } from './seam';

export const DELIVERY_POLL_MS = 15_000;
/** Gaps between the re-reads of a fresh delivery's burst (≈1 s, 3 s, 7 s, 15 s after it starts). */
export const DELIVERY_FAST_POLL_MS = [1_000, 2_000, 4_000, 8_000] as const;

export function errorText(e: unknown): string {
  if (e instanceof FormsPortError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export interface QuestionnaireDetail {
  id: string;
  title: string;
  version: number;
  content: unknown;
}

/** The newer of two states for the same form (a null never wins). */
function newer(a: FormState | null, b: FormState | null): FormState | null {
  if (!a) return b;
  if (!b) return a;
  return b.version > a.version ? b : a;
}

/** The server's page order: `submittedAt desc, id desc`. True when `a` sorts at or after `b`. */
function atOrAfter(a: FormResponseView, b: FormResponseView): boolean {
  const at = a.submittedAt ?? '';
  const bt = b.submittedAt ?? '';
  return at < bt || (at === bt && a.id <= b.id);
}

/** Work sessions with a pending delivery among these responses. */
function pendingSessions(rows: readonly (FormResponseView | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) for (const d of r?.deliveries ?? []) if (d.status === 'pending') out.add(d.workSessionId);
  return out;
}

/** Fresh deliveries (pending, never attempted, still inside the grace window) as one stable key. */
function freshDeliveries(
  rows: readonly (FormResponseView | null | undefined)[],
  since: (r: FormResponseView) => number | null,
  now: number,
): string {
  const out = new Set<string>();
  for (const r of rows) {
    if (!r) continue;
    const start = since(r);
    if (start === null || now - start >= DELIVERING_GRACE_MS) continue;
    for (const d of r.deliveries) {
      if (d.status === 'pending' && d.attempts === 0 && !d.lastError) out.add(`${r.id}:${d.workSessionId}`);
    }
  }
  return [...out].sort().join(' ');
}

const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function useQuestionnaire(detail: QuestionnaireDetail) {
  const port = useFormsPort();
  const base = useMemo<FormState | null>(() => {
    const content = formContentOf(detail.content);
    return content ? { id: detail.id, title: detail.title, version: detail.version, content } : null;
  }, [detail.id, detail.title, detail.version, detail.content]);

  // A write's result, or a refetched detail, wins until the host hands us a newer one.
  const [written, setWritten] = useState<FormState | null>(null);
  const form = newer(base, written && written.id === detail.id ? written : null);

  const [mine, setMine] = useState<MyFormSlot | null>(null);
  const [responses, setResponses] = useState<FormResponseView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // The oldest row a "Load more" reached (null: page 1 only), and a sequence
  // so a stale page never overwrites a newer read.
  const through = useRef<FormResponseView | null>(null);
  const fetchSeq = useRef(0);

  /** Page 1, then on through `through`: what the reader had loaded, re-read. */
  const readLoaded = useCallback(async () => {
    const items: FormResponseView[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await port.responses(detail.id, cursor);
      for (const r of page.items) if (!seen.has(r.id)) { seen.add(r.id); items.push(r); }
      cursor = page.nextCursor;
      const last = items[items.length - 1];
      if (!through.current || (last && atOrAfter(last, through.current))) break;
    } while (cursor);
    return { items, cursor };
  }, [port, detail.id]);

  const reload = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const [slot, page] = await Promise.all([port.mine(detail.id), readLoaded()]);
      setMine(slot);
      if (seq !== fetchSeq.current) return;
      setResponses(page.items);
      setNextCursor(page.cursor);
      setError(null);
    } catch (e) {
      if (seq === fetchSeq.current) setError(errorText(e));
    }
  }, [port, detail.id, readLoaded]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const seq = ++fetchSeq.current;
    setLoadingMore(true);
    try {
      const page = await port.responses(detail.id, nextCursor);
      if (seq !== fetchSeq.current) return;
      const last = page.items[page.items.length - 1];
      if (last) through.current = last;
      setResponses((rows) => {
        const have = new Set((rows ?? []).map((r) => r.id));
        return [...(rows ?? []), ...page.items.filter((r) => !have.has(r.id))];
      });
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (e) {
      if (seq === fetchSeq.current) setError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  }, [port, detail.id, nextCursor]);

  const refetchForm = useCallback(async () => {
    try {
      const next = await port.form(detail.id);
      setWritten((w) => newer(w, next));
      setDetailError(null);
    } catch (e) {
      setDetailError(errorText(e));
    }
  }, [port, detail.id]);

  // A host detail without the questions (a list row): fetch the real one.
  useEffect(() => {
    if (!base) void refetchForm();
  }, [base, refetchForm]);

  const pending = useMemo(
    () => pendingSessions([mine?.current, ...(responses ?? [])]),
    [mine, responses],
  );
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  /** When this viewer last submitted (their clock), for the grace window. */
  const [localSubmitAt, setLocalSubmitAt] = useState<number | null>(null);
  const currentId = mine?.current?.id ?? null;
  const deliverySince = useCallback(
    (r: FormResponseView) => deliveryStart(r.submittedAt, r.id === currentId ? localSubmitAt : null),
    [currentId, localSubmitAt],
  );
  const markSubmitted = useCallback(() => setLocalSubmitAt(Date.now()), []);
  const fresh = useMemo(
    () => freshDeliveries([mine?.current, ...(responses ?? [])], deliverySince, Date.now()),
    [mine, responses, deliverySince],
  );

  useEffect(() => {
    void reload();
    return port.subscribe(detail.id, (change) => {
      if (change.kind === 'form') {
        void refetchForm();
        void reload();
      } else if (change.kind === 'responses') {
        void reload();
      } else if (pendingRef.current.has(change.sessionId)) {
        void reload();
      }
    });
  }, [port, detail.id, reload, refetchForm]);

  // The fast burst while a fresh delivery is shown: visible only, and over
  // once the rows settle (the key empties) or the backoff runs out.
  const bursting = useRef(false);
  useEffect(() => {
    if (!fresh) return;
    let step = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      bursting.current = step < DELIVERY_FAST_POLL_MS.length;
      if (!bursting.current) return;
      timer = setTimeout(() => {
        step += 1;
        if (pageVisible()) void reload();
        next();
      }, DELIVERY_FAST_POLL_MS[step]);
    };
    next();
    return () => {
      clearTimeout(timer);
      bursting.current = false;
    };
  }, [fresh, reload]);

  // The backstop poll: responses only, visible only, pending only.
  const hasPending = pending.size > 0;
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      if (pageVisible() && !bursting.current) void reload();
    }, DELIVERY_POLL_MS);
    return () => clearInterval(timer);
  }, [hasPending, reload]);

  return {
    port,
    form,
    setForm: setWritten,
    mine,
    responses,
    /** More current responses exist past the loaded pages. */
    hasMore: nextCursor !== null,
    loadMore,
    loadingMore,
    /** One freeze rule (§5): the first submitted response. Submitted rows are never deleted. */
    frozen: (responses?.length ?? 0) > 0,
    loading: mine === null || responses === null,
    error,
    /** Why the form's detail could not be read (shown instead of a blank panel). */
    detailError,
    reload,
    refetchForm,
    /** When a response's delivery started, for `DeliveryChip`/`DeliveryNote`'s grace window. */
    deliverySince,
    /** This viewer just submitted: date their row by their own clock (call before `reload`). */
    markSubmitted,
  };
}

export type Questionnaire = ReturnType<typeof useQuestionnaire>;
