/**
 * Draft form values (Spec D §3; formerly Spec B §8 browser storage).
 *
 * SERVER MODE (a node that keeps workspaces): values live in memory here and
 * on the node (`workspace_drafts`). A `set` applies at once in this window,
 * bumps the in-memory value revision (which `interactions.resolve` uses to
 * cancel a discard after a late keystroke, §5.6 step 5), and sends the CHANGED
 * fields ~400 ms later with the field revision each was based on. The node
 * merges per field, last writer wins, and pushes the result to every window;
 * `applyRemote` lands it here. A window whose own edit is still unsent keeps
 * its edit (it wins on send); otherwise the remote value replaces what this
 * window shows, the draft's remote version bumps (the form remounts with it),
 * and listeners hear about it ("Updated in another window").
 *
 * LEGACY / OFFLINE: before the node answers, and on a node without stored
 * workspaces, values are read from the old `tm8.ws.draft.v1:{viewer}:{space}:
 * {draftId}` keys — read-only once server mode is on (the one-time import
 * carries them to the node). Writes go to those keys only when no sync is
 * attached.
 */
const DRAFT_VERSION = 1;
const WRITE_DEBOUNCE_MS = 400;

export interface DraftScope {
  viewerId: string;
  spaceId: string;
}

/** What the server sync gives a scope: the sender for a debounced patch. */
export interface DraftSync {
  send(draftId: string, fields: Record<string, { v: unknown; base: number }>): void;
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

interface Server {
  values: Record<string, unknown>;
  revs: Record<string, number>;
}

const revisions = new Map<string, number>();
const remoteVersions = new Map<string, number>();
const pendingWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; values: Record<string, unknown>; scope: DraftScope; draftId: string }>();
const serverCopies = new Map<string, Server>();
const syncs = new Map<string, DraftSync>();
const listeners = new Set<(key: string, remote: boolean) => void>();

const scopeKeyOf = (scope: DraftScope) => `${scope.viewerId}:${scope.spaceId}`;

/** Order-independent JSON, so `{a,b}` and `{b,a}` compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readLegacy(key: string): Record<string, unknown> | null {
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

function writeLegacy(key: string, values: Record<string, unknown>): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ version: DRAFT_VERSION, values, updatedAt: new Date().toISOString() }));
  } catch {
    // Storage may be disabled or full; the form keeps the live values.
  }
}

function sendOrStore(key: string, scope: DraftScope, draftId: string, values: Record<string, unknown>): void {
  const sync = syncs.get(scopeKeyOf(scope));
  if (!sync) {
    writeLegacy(key, values);
    return;
  }
  const server = serverCopies.get(key) ?? { values: {}, revs: {} };
  const fields: Record<string, { v: unknown; base: number }> = {};
  for (const [name, value] of Object.entries(values)) {
    if (stable(value) !== stable(server.values[name])) fields[name] = { v: value, base: server.revs[name] ?? 0 };
  }
  if (Object.keys(fields).length === 0) return;
  // What this window sent is what it shows: the node's echo of it must not
  // read as someone else's change.
  serverCopies.set(key, { values: { ...server.values, ...values }, revs: server.revs });
  sync.send(draftId, fields);
}

/** Read a draft's values; an unsent local write wins, then the node's, then legacy storage. */
export function getDraftValues(scope: DraftScope, draftId: string): Record<string, unknown> | null {
  const key = draftKey(scope, draftId);
  const queued = pendingWrites.get(key);
  if (queued) return queued.values;
  const server = serverCopies.get(key);
  if (server) return { ...server.values };
  return readLegacy(key);
}

/** Store a draft's values: at once here, debounced to the node (or legacy storage). */
export function setDraftValues(scope: DraftScope, draftId: string, values: Record<string, unknown>): void {
  const key = draftKey(scope, draftId);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  const queued = pendingWrites.get(key);
  if (queued) clearTimeout(queued.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    sendOrStore(key, scope, draftId, values);
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(key, { timer, values, scope, draftId });
  for (const listener of listeners) listener(key, false);
}

export function deleteDraftValues(scope: DraftScope, draftId: string): void {
  const key = draftKey(scope, draftId);
  const queued = pendingWrites.get(key);
  if (queued) clearTimeout(queued.timer);
  pendingWrites.delete(key);
  revisions.delete(key);
  serverCopies.delete(key);
  // The node drops its row with the commit that closed the draft.
  if (!syncs.has(scopeKeyOf(scope))) {
    try {
      browserStorage()?.removeItem(key);
    } catch {
      // ignore
    }
  }
}

export function draftRevisionOf(scope: DraftScope, draftId: string): number {
  return revisions.get(draftKey(scope, draftId)) ?? 0;
}

/** Bumps each time the node replaced what this window shows for the draft. */
export function draftRemoteVersionOf(scope: DraftScope, draftId: string): number {
  return remoteVersions.get(draftKey(scope, draftId)) ?? 0;
}

/** Send or write every queued draft now (pagehide, blur, store swap). */
export function flushDraftValues(): void {
  for (const [key, queued] of pendingWrites) {
    clearTimeout(queued.timer);
    sendOrStore(key, queued.scope, queued.draftId, queued.values);
  }
  pendingWrites.clear();
}

/** Attach (or detach, with null) the node sync for one (viewer, space). */
export function setDraftSync(scope: DraftScope, sync: DraftSync | null): void {
  if (sync) syncs.set(scopeKeyOf(scope), sync);
  else syncs.delete(scopeKeyOf(scope));
}

/**
 * The node's copy of a draft arrived (its push, or the snapshot after
 * register). Returns true when it replaced what this window shows.
 */
export function applyRemoteDraft(
  scope: DraftScope,
  draftId: string,
  fields: Record<string, { v: unknown; r: number }> | null,
): boolean {
  const key = draftKey(scope, draftId);
  if (fields === null) {
    serverCopies.delete(key);
    return false;
  }
  const values: Record<string, unknown> = {};
  const revs: Record<string, number> = {};
  for (const [name, { v, r }] of Object.entries(fields)) {
    values[name] = v;
    revs[name] = r;
  }
  const before = getDraftValues(scope, draftId);
  serverCopies.set(key, { values, revs });
  // An unsent local edit is kept; it is sent next and wins (last writer).
  if (pendingWrites.has(key)) return false;
  if (stable(before ?? {}) === stable(values)) return false;
  remoteVersions.set(key, (remoteVersions.get(key) ?? 0) + 1);
  for (const listener of listeners) listener(key, true);
  return true;
}

/** Listen to draft changes (`remote` = the node replaced the values). */
export function subscribeDrafts(listener: (key: string, remote: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every legacy draft value for a scope, for the one-time import. */
export function legacyDraftValues(scope: DraftScope, draftIds: readonly string[]): { draftId: string; values: Record<string, unknown> }[] {
  return draftIds.flatMap((draftId) => {
    const key = draftKey(scope, draftId);
    const values = pendingWrites.get(key)?.values ?? readLegacy(key);
    return values ? [{ draftId, values }] : [];
  });
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
    remoteVersionOf: (draftId: string) => draftRemoteVersionOf(scope, draftId),
    applyRemote: (draftId: string, fields: Record<string, { v: unknown; r: number }> | null) => applyRemoteDraft(scope, draftId, fields),
    attach: (sync: DraftSync | null) => setDraftSync(scope, sync),
    legacy: (draftIds: readonly string[]) => legacyDraftValues(scope, draftIds),
    scope,
  };
}
export type DraftStore = ReturnType<typeof draftStoreFor>;
