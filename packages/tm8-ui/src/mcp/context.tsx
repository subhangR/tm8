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
 *   failed        the latest read failed; whatever was shown STAYS shown,
 *                 with the error beside it (a picker whose re-read fails does
 *                 not collapse rows that were right a second ago)
 *
 * Invariants: a catalog is never shown under another scope's key; `failed`
 * keeps the catalog it was showing and has none only when nothing was shown;
 * `loading` in the result is exactly `loading` or `revalidating`, the meaning
 * every existing reader of it already relies on.
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
interface CatalogSnapshot { phase: CatalogPhase; catalog?: McpCatalog; error?: string }
type CatalogEvent =
  /** A read starts. `seed` is the scope's last-known catalog, used only when nothing is shown yet. */
  | { type: 'read'; seed?: McpCatalog | undefined }
  | { type: 'answered'; catalog: McpCatalog }
  | { type: 'failed'; error: string };

const NOTHING: CatalogSnapshot = { phase: 'loading' };

function step(current: CatalogSnapshot, event: CatalogEvent): CatalogSnapshot {
  switch (event.type) {
    case 'read': {
      const shown = current.catalog ?? event.seed;
      return shown ? { phase: 'revalidating', catalog: shown } : { phase: 'loading' };
    }
    case 'answered': return { phase: 'ready', catalog: event.catalog };
    case 'failed': return current.catalog
      ? { phase: 'failed', catalog: current.catalog, error: event.error }
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
    void port.catalog(targetId, teamMemberId).then(
      catalog => {
        // Remembered even when this mount is gone: a card closed before its
        // first read landed is exactly the one whose next open needs the seed.
        if (keep) remember(port, scope, catalog);
        if (!active) return;
        setState(previous => ({ ...previous, snapshot: step(previous.snapshot, { type: 'answered', catalog }) }));
      },
      // A failure forgets nothing. The scope's last-known copy is shown
      // whenever it exists, so a failed read either keeps showing it (and
      // says so) or had none to forget.
      () => {
        if (!active) return;
        setState(previous => ({ ...previous, snapshot: step(previous.snapshot, { type: 'failed', error: 'Connectors could not be loaded. Try again.' }) }));
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
    port,
    refresh,
  };
}
