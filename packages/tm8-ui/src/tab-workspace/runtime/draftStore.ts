/**
 * Draft form values, one localStorage key per draft (Spec B §8):
 * `tm8.ws.draft.v1:{viewer}:{space}:{draftId}`. Follows the chat-draft
 * pattern (`channel-screen/chat-store.ts`): versioned payload, malformed
 * values read as absent, storage failures are swallowed.
 *
 * Writes are debounced (~400 ms) and flushed on `pagehide`. Every `set` bumps
 * an in-memory value revision, which `interactions.resolve` uses to cancel a
 * discard when a keystroke landed after the prompt (§5.6 step 5).
 */
const DRAFT_VERSION = 1;
const WRITE_DEBOUNCE_MS = 400;

export interface DraftScope {
  viewerId: string;
  spaceId: string;
}

export function draftKey(scope: DraftScope, draftId: string): string {
  return `tm8.ws.draft.v1:${scope.viewerId}:${scope.spaceId}:${draftId}`;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const revisions = new Map<string, number>();
const pendingWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; values: Record<string, unknown> }>();

function writeNow(key: string, values: Record<string, unknown>): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ version: DRAFT_VERSION, values, updatedAt: new Date().toISOString() }));
  } catch {
    // Storage may be disabled or full; the form keeps the live values.
  }
}

/** Read a draft's stored values; a pending (unflushed) write wins. */
export function getDraftValues(scope: DraftScope, draftId: string): Record<string, unknown> | null {
  const key = draftKey(scope, draftId);
  const queued = pendingWrites.get(key);
  if (queued) return queued.values;
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== DRAFT_VERSION || !isRecord(parsed.values)) return null;
    return parsed.values;
  } catch {
    return null;
  }
}

/** Store a draft's values (debounced write; revision bumps immediately). */
export function setDraftValues(scope: DraftScope, draftId: string, values: Record<string, unknown>): void {
  const key = draftKey(scope, draftId);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  const queued = pendingWrites.get(key);
  if (queued) clearTimeout(queued.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    writeNow(key, values);
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(key, { timer, values });
}

export function deleteDraftValues(scope: DraftScope, draftId: string): void {
  const key = draftKey(scope, draftId);
  const queued = pendingWrites.get(key);
  if (queued) clearTimeout(queued.timer);
  pendingWrites.delete(key);
  revisions.delete(key);
  try {
    browserStorage()?.removeItem(key);
  } catch {
    // ignore
  }
}

export function draftRevisionOf(scope: DraftScope, draftId: string): number {
  return revisions.get(draftKey(scope, draftId)) ?? 0;
}

/** Write every queued draft now (pagehide, store swap). */
export function flushDraftValues(): void {
  for (const [key, queued] of pendingWrites) {
    clearTimeout(queued.timer);
    writeNow(key, queued.values);
  }
  pendingWrites.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDraftValues);
}

/** Bound helpers for one (viewer, space). */
export function draftStoreFor(scope: DraftScope) {
  return {
    get: (draftId: string) => getDraftValues(scope, draftId),
    set: (draftId: string, values: Record<string, unknown>) => setDraftValues(scope, draftId, values),
    delete: (draftId: string) => deleteDraftValues(scope, draftId),
    revisionOf: (draftId: string) => draftRevisionOf(scope, draftId),
  };
}
export type DraftStore = ReturnType<typeof draftStoreFor>;
