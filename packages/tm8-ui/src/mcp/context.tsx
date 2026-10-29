/**
 * THE CONNECTOR CATALOG, per scope, for every MCP surface.
 *
 * `McpProvider` holds the port and a revision; `refresh()`, and the window
 * regaining focus, bumps the revision so every mounted `useMcpCatalog` reads
 * again. `useMcpCatalog(targetId, teamMemberId)` answers ONE scope — that pair
 * — as an explicit phase, and `step` is the only place a phase changes:
 *
 *   unavailable   no port: this host serves no connectors
 *   loading       nothing to show yet; a read is in flight
 *   revalidating  a catalog is shown — the previous revision's, or with
 *                 `lastKnown` the scope's previous read — while a read is in flight
 *   ready         the catalog is the latest read's answer
 *   failed        the latest read failed. A LAUNCH PICKER (`lastKnown`)
 *                 keeps what it was showing, with the error beside it, so a
 *                 re-read that fails does not collapse chips that were right
 *                 a second ago. Every other surface gets no catalog, so its
 *                 error is drawn and a management surface never acts on a
 *                 stale `server.version`.
 *
 * `seeded` is true while the catalog shown is the scope's LAST-KNOWN copy and
 * this mount's own read has not answered yet: a photograph, which the launch
 * gate will not judge an explicit pick against.
 *
 * Invariants: a catalog is never shown under another scope's key; only a
 * `lastKnown` reader keeps a catalog under `failed`; an older read never
 * overwrites a newer one's last-known copy; `loading` in the result is exactly
 * `loading` or `revalidating`, the meaning every existing reader relies on.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { McpCatalog, McpPort } from './port';
const Context = createContext<{ port: McpPort | null; revision: number; refresh(): void }>({ port: null, revision: 0, refresh() {} });
export const useMcpPort = () => useContext(Context).port;
export function McpProvider({ port, children }: { port: McpPort | null; children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  const value = useMemo(() => ({ port, revision, refresh }), [port, revision, refresh]);
  useEffect(() => { window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export type CatalogPhase = 'unavailable' | 'loading' | 'revalidating' | 'ready' | 'failed';
interface CatalogSnapshot { phase: CatalogPhase; catalog?: McpCatalog; error?: string; seeded?: boolean }
type CatalogEvent =
  /** A read starts. `seed` is the scope's last-known catalog, used only when nothing is shown yet. */
  | { type: 'read'; seed?: McpCatalog | undefined }
  | { type: 'answered'; catalog: McpCatalog }
  /** `keepShown`: the reader is a launch picker, which keeps what it shows. */
  | { type: 'failed'; error: string; keepShown: boolean };

const NOTHING: CatalogSnapshot = { phase: 'loading' };

function step(current: CatalogSnapshot, event: CatalogEvent): CatalogSnapshot {
  switch (event.type) {
    case 'read': {
      if (current.catalog) return { phase: 'revalidating', catalog: current.catalog, ...(current.seeded ? { seeded: true } : {}) };
      return event.seed ? { phase: 'revalidating', catalog: event.seed, seeded: true } : { phase: 'loading' };
    }
    case 'answered': return { phase: 'ready', catalog: event.catalog };
    case 'failed': return event.keepShown && current.catalog
      ? { phase: 'failed', catalog: current.catalog, error: event.error, ...(current.seeded ? { seeded: true } : {}) }
      : { phase: 'failed', error: event.error };
  }
}

/**
 * THE LAST CATALOG EACH SCOPE READ, for a picker that is mounted fresh every
 * time it is shown — the launch card is. It seeds `revalidating`, so a
 * reopened card has its chips (and its count) on the first frame instead of a
 * round trip later, and the same mount's read replaces it.
 *
 * Keyed by port, so a replaced port (another Space, a reconnect) never sees
 * this one's catalog, and by the EXACT scope: defaults and attachments are per
 * target and per teammate, so a catalog read for one task would draw another
 * task's defaults as on.
 *
 * OPT-IN (`lastKnown`). A management surface acts on `server.version`, and
 * acting on a stale version is a version conflict; the pickers only read.
 */
const lastKnown = new WeakMap<McpPort, Map<string, McpCatalog>>();
/** Scopes kept per port. A person opens a few tasks, not hundreds; the oldest goes first. */
const LAST_KNOWN_SCOPES = 16;
/** The newest read STARTED per port and scope: only its answer may become the last-known copy. */
const readSeq = new WeakMap<McpPort, Map<string, number>>();
function startRead(port: McpPort, scope: string): number {
  let scopes = readSeq.get(port);
  if (!scopes) { scopes = new Map(); readSeq.set(port, scopes); }
  const n = (scopes.get(scope) ?? 0) + 1;
  scopes.set(scope, n);
  return n;
}
function remember(port: McpPort, scope: string, catalog: McpCatalog) {
  let scopes = lastKnown.get(port);
  if (!scopes) { scopes = new Map(); lastKnown.set(port, scopes); }
  scopes.delete(scope);
  scopes.set(scope, catalog);
  for (const oldest of scopes.keys()) { if (scopes.size <= LAST_KNOWN_SCOPES) break; scopes.delete(oldest); }
}

export function useMcpCatalog(targetId?: string, teamMemberId?: string, options?: { lastKnown?: boolean }) {
  const { port, revision, refresh } = useContext(Context);
  const scope = JSON.stringify([targetId, teamMemberId]);
  const keep = options?.lastKnown === true;
  const seed = keep && port ? lastKnown.get(port)?.get(scope) : undefined;
  const [state, setState] = useState<{ port: McpPort | null; scope: string; revision: number; snapshot: CatalogSnapshot }>(
    () => ({ port, scope, revision, snapshot: step(NOTHING, { type: 'read', seed }) }));
  useEffect(() => {
    if (!port) return;
    let active = true;
    const start = keep ? lastKnown.get(port)?.get(scope) : undefined;
    setState(previous => ({ port, scope, revision,
      snapshot: step(previous.port === port && previous.scope === scope ? previous.snapshot : NOTHING, { type: 'read', seed: start }) }));
    const seq = keep ? startRead(port, scope) : 0;
    void port.catalog(targetId, teamMemberId).then(
      catalog => {
        // Remembered even when this mount is gone — a card closed before its
        // first read landed is exactly the one whose next open needs the seed —
        // but only if no newer read for the scope has started since.
        if (keep && readSeq.get(port)?.get(scope) === seq) remember(port, scope, catalog);
        if (!active) return;
        setState(previous => ({ ...previous, snapshot: step(previous.snapshot, { type: 'answered', catalog }) }));
      },
      // A failure forgets nothing. The scope's last-known copy is shown
      // whenever it exists, so a failed read either keeps showing it (and
      // says so) or had none to forget.
      () => {
        if (!active) return;
        setState(previous => ({ ...previous, snapshot: step(previous.snapshot, { type: 'failed', error: 'Connectors could not be loaded. Try again.', keepShown: keep }) }));
      },
    );
    return () => { active = false; };
  }, [port, targetId, teamMemberId, scope, revision, keep]);
  // The render between a new scope or revision and its effect already shows
  // the read as started, so no frame claims a stale answer is `ready`.
  const snapshot: CatalogSnapshot = !port
    ? { phase: 'unavailable' }
    : state.port === port && state.scope === scope
      ? state.revision === revision ? state.snapshot : step(state.snapshot, { type: 'read' })
      : step(NOTHING, { type: 'read', seed });
  return {
    phase: snapshot.phase,
    catalog: snapshot.catalog,
    error: snapshot.error,
    loading: snapshot.phase === 'loading' || snapshot.phase === 'revalidating',
    seeded: snapshot.seeded === true,
    port,
    refresh,
  };
}
