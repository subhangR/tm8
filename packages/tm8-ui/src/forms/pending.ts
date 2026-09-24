/**
 * FORMS WAITING ON SESSIONS: the one read behind the session tile chip and
 * the session panel banner (FORMS-DESIGN §10, decision 11).
 *
 * ONE READ FOR MANY TILES. Every mounted tile and banner `register`s its
 * session id; the store batches whatever is registered in the same debounce
 * window into `forms.pendingForSessions` calls of at most
 * FORMS_PENDING_MAX_SESSIONS ids each. A list of 40 sessions costs one
 * request, never 40.
 *
 * LIVE WITHOUT NEW SOCKET TRAFFIC (§10). The store refetches the registered
 * set, debounced, when an event that already exists can change the answer:
 *   - entity.upsert / entity.deleted / entity.activity_touched of a FORM
 *     (open, close, cancel, a structure edit; attention raise/resolve touches
 *     the form row);
 *   - a message on a form this store has listed (a submit posts on
 *     [session, form], §7.1);
 *   - entity.upsert of a REGISTERED work_session (a status move to
 *     running/idle is when a queued answer drains);
 *   - a resync of the space.
 * Draft save/discard is private and has no space event, so the banner calls
 * `refresh()` after its own writes.
 *
 * With no provider mounted every hook answers `null`, so a tile renders no chip.
 */
import { createContext, createElement, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { DurableWorkspaceEvent } from '@tm8/contract';
import type { QuestionnaireDetail } from './useQuestionnaire';

// ---------------------------------------------------------------------------
// The wire shape is the contract's (`forms.pendingForSessions`).
// ---------------------------------------------------------------------------

import { FORMS_PENDING_MAX_SESSIONS } from '@tm8/contract';
import type { FormPendingItem, FormPendingSession, FormsPendingForSessionsResult } from '@tm8/contract';

export { FORMS_PENDING_MAX_SESSIONS };
export type { FormPendingItem, FormPendingSession, FormsPendingForSessionsResult };

// ---------------------------------------------------------------------------
// The source (the adapter the host builds from its seam)
// ---------------------------------------------------------------------------

export interface PendingFormsSource {
  spaceId: string;
  pendingForSessions(input: { spaceId: string; sessionIds: string[] }): Promise<FormsPendingForSessionsResult>;
  /** A form's full detail, which the banner's inline Fill renders. */
  formDetail(formId: string): Promise<QuestionnaireDetail>;
  onEvent(cb: (e: DurableWorkspaceEvent) => void): () => void;
  onResync?(cb: (spaceId: string) => void): () => void;
}

export interface PendingFormsStore {
  readonly source: PendingFormsSource;
  /** Keep this session's answer current while the returned release is unheld. */
  register(sessionId: string): () => void;
  /** The session's waiting forms and queued answers, or null when there are none. */
  get(sessionId: string): FormPendingSession | null;
  subscribe(cb: () => void): () => void;
  /** Refetch the registered set (debounced). */
  refresh(): void;
  /** Resolves when no fetch is scheduled or in flight (tests). */
  settled(): Promise<void>;
  dispose(): void;
}

export const PENDING_FORMS_DEBOUNCE_MS = 300;

export function createPendingFormsStore(
  source: PendingFormsSource,
  { debounceMs = PENDING_FORMS_DEBOUNCE_MS }: { debounceMs?: number } = {},
): PendingFormsStore {
  const refs = new Map<string, number>();
  let answers = new Map<string, FormPendingSession>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let again = false;
  let disposed = false;

  const emit = () => listeners.forEach((cb) => cb());

  /** Form ids this store has listed. A message on one of them may be a submit. */
  const knownForm = (id: string) => {
    for (const s of answers.values()) if (s.forms.some((f) => f.formId === id)) return true;
    return false;
  };

  async function fetchAll(): Promise<void> {
    const ids = [...refs.keys()];
    if (ids.length === 0) return;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += FORMS_PENDING_MAX_SESSIONS) {
      chunks.push(ids.slice(i, i + FORMS_PENDING_MAX_SESSIONS));
    }
    const results = await Promise.all(
      chunks.map((sessionIds) => source.pendingForSessions({ spaceId: source.spaceId, sessionIds })),
    );
    if (disposed) return;
    const next = new Map<string, FormPendingSession>();
    for (const r of results) for (const s of r.sessions) next.set(s.workSessionId, s);
    // Keep the previous object where nothing changed, so tiles don't re-render.
    for (const [id, s] of next) {
      const prev = answers.get(id);
      if (prev && JSON.stringify(prev) === JSON.stringify(s)) next.set(id, prev);
    }
    const changed = next.size !== answers.size || [...next].some(([id, s]) => answers.get(id) !== s);
    answers = next;
    if (changed) emit();
  }

  function run(): void {
    timer = null;
    if (inflight) {
      again = true;
      return;
    }
    inflight = fetchAll()
      .catch(() => {
        // A failed read keeps the last answer. The next event or mount retries.
      })
      .finally(() => {
        inflight = null;
        if (again && !disposed) {
          again = false;
          schedule();
        }
      });
  }

  function schedule(): void {
    if (disposed || timer) return;
    timer = setTimeout(run, debounceMs);
  }

  function onEvent(e: DurableWorkspaceEvent): void {
    switch (e.type) {
      case 'entity.upsert':
      case 'entity.deleted':
        if (e.entity.kind === 'form' || (e.entity.kind === 'work_session' && refs.has(e.entity.id))) schedule();
        return;
      case 'entity.activity_touched':
        if (e.kind === 'form') schedule();
        return;
      case 'message.created':
      case 'message.deleted':
        if (knownForm(e.anchorId)) schedule();
        return;
      default:
        return;
    }
  }

  const offEvent = source.onEvent(onEvent);
  const offResync = source.onResync?.((spaceId) => {
    if (spaceId === source.spaceId) schedule();
  });

  return {
    source,
    register(sessionId) {
      const n = refs.get(sessionId) ?? 0;
      refs.set(sessionId, n + 1);
      if (n === 0) schedule();
      return () => {
        const left = (refs.get(sessionId) ?? 1) - 1;
        if (left <= 0) refs.delete(sessionId);
        else refs.set(sessionId, left);
      };
    },
    get: (sessionId) => answers.get(sessionId) ?? null,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refresh: schedule,
    async settled() {
      while (timer || inflight) {
        if (timer) {
          clearTimeout(timer);
          run();
        }
        await inflight;
      }
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      offEvent();
      offResync?.();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

const PendingFormsContext = createContext<PendingFormsStore | null>(null);

export function PendingFormsProvider({ store, children }: { store: PendingFormsStore | null; children?: ReactNode }) {
  return createElement(PendingFormsContext.Provider, { value: store }, children);
}

export function usePendingFormsStore(): PendingFormsStore | null {
  return useContext(PendingFormsContext);
}

const NO_SUBSCRIBE = () => () => {};

/** This session's waiting forms for the viewer. `null` = none, or no provider. */
export function usePendingForms(sessionId: string | null): FormPendingSession | null {
  const store = useContext(PendingFormsContext);
  useEffect(() => (store && sessionId ? store.register(sessionId) : undefined), [store, sessionId]);
  return useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIBE,
    () => (store && sessionId ? store.get(sessionId) : null),
  );
}

// ---------------------------------------------------------------------------
// Words (decision 11: "1 form waiting")
// ---------------------------------------------------------------------------

export function formsWaitingText(total: number): string {
  return `${total} form${total === 1 ? '' : 's'} waiting`;
}

export function answersQueuedText(queued: number): string {
  return `${queued} answer${queued === 1 ? '' : 's'} queued`;
}

// ---------------------------------------------------------------------------
// The host's adapter
// ---------------------------------------------------------------------------

/** The seam surface the store needs. */
export interface PendingFormsSeam {
  formsPendingForSessions?(input: { spaceId: string; sessionIds: string[] }): Promise<FormsPendingForSessionsResult>;
  entity(id: string): Promise<QuestionnaireDetail>;
  onEvent(cb: (e: DurableWorkspaceEvent) => void): () => void;
  onResync(cb: (spaceId: string) => void): () => void;
}

/** The source for a space, or null when the seam has no pending read (no chip, no banner). */
export function pendingFormsSourceFor(seam: PendingFormsSeam, spaceId: string | null | undefined): PendingFormsSource | null {
  const read = seam.formsPendingForSessions;
  if (!read || !spaceId) return null;
  return {
    spaceId,
    pendingForSessions: (input) => read.call(seam, input),
    formDetail: (formId) => seam.entity(formId),
    onEvent: (cb) => seam.onEvent(cb),
    onResync: (cb) => seam.onResync(cb),
  };
}

/** One store per (seam, space), disposed when either changes. */
export function usePendingFormsStoreFor(seam: PendingFormsSeam, spaceId: string | null | undefined): PendingFormsStore | null {
  const [store, setStore] = useState<PendingFormsStore | null>(null);
  useEffect(() => {
    const source = pendingFormsSourceFor(seam, spaceId);
    const next = source ? createPendingFormsStore(source) : null;
    setStore(next);
    return () => next?.dispose();
  }, [seam, spaceId]);
  return store;
}
