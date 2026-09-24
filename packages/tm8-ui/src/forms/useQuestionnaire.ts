/**
 * The block's one data hook: the form (from the entity detail, overridden by
 * whatever a Build/lifecycle write returned), the viewer's slot and the
 * current responses — all through the seam, re-read when the port says the
 * form changed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormsPort, FormsPortError, type FormContentView, type FormResponseView, type FormState, type MyFormSlot } from './seam';

/** A form's content, recognised by SHAPE (questions, sections, settings, status). */
export function formContentOf(content: unknown): FormContentView | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  return Array.isArray(c.questions) && Array.isArray(c.sections) && typeof c.settings === 'object' && c.settings !== null
    && typeof c.status === 'string'
    ? (c as unknown as FormContentView)
    : null;
}

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

export function useQuestionnaire(detail: QuestionnaireDetail) {
  const port = useFormsPort();
  const base = useMemo<FormState | null>(() => {
    const content = formContentOf(detail.content);
    return content ? { id: detail.id, title: detail.title, version: detail.version, content } : null;
  }, [detail.id, detail.title, detail.version, detail.content]);

  // A write's result wins until the host hands us a newer detail.
  const [written, setWritten] = useState<FormState | null>(null);
  const form = written && base && written.id === base.id && written.version >= base.version ? written : base;

  const [mine, setMine] = useState<MyFormSlot | null>(null);
  const [responses, setResponses] = useState<FormResponseView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void reload();
    return port.subscribe(detail.id, () => void reload());
  }, [port, detail.id, reload]);

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
    reload,
  };
}

export type Questionnaire = ReturnType<typeof useQuestionnaire>;
