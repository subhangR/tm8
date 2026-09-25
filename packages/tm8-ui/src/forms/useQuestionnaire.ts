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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormsPortError, formContentOf, useFormsPort, type FormResponseView, type FormState, type MyFormSlot } from './seam';

export { formContentOf } from './seam';

export const DELIVERY_POLL_MS = 15_000;

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
/**
 * The host's detail (`a`) against this hook's own write or refetch (`b`).
 * A TIE GOES TO `b`: the host bumps its detail's version from the thin entity
 * event, which carries no questions, and keeps the content it already had, so
 * at an equal version only `b` is known to hold that version's content.
 */
function newer(a: FormState | null, b: FormState | null): FormState | null {
  if (!a) return b;
  if (!b) return a;
  return b.version >= a.version ? b : a;
}

/** Work sessions with a pending delivery among these responses. */
function pendingSessions(rows: readonly (FormResponseView | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) for (const d of r?.deliveries ?? []) if (d.status === 'pending') out.add(d.workSessionId);
  return out;
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

  const reload = useCallback(async () => {
    try {
      const [slot, page] = await Promise.all([port.mine(detail.id), port.responses(detail.id)]);
      setMine(slot);
      setResponses(page.items);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [port, detail.id]);

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

  // The backstop poll: responses only, visible only, pending only.
  const hasPending = pending.size > 0;
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      if (pageVisible()) void reload();
    }, DELIVERY_POLL_MS);
    return () => clearInterval(timer);
  }, [hasPending, reload]);

  return {
    port,
    form,
    setForm: setWritten,
    mine,
    responses,
    /** One freeze rule (§5): the first submitted response. Submitted rows are never deleted. */
    frozen: (responses?.length ?? 0) > 0,
    loading: mine === null || responses === null,
    error,
    /** Why the form's detail could not be read (shown instead of a blank panel). */
    detailError,
    reload,
    refetchForm,
  };
}

export type Questionnaire = ReturnType<typeof useQuestionnaire>;
