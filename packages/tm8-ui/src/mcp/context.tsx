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
 * overwrites a newer one's last-known copy; a failed read forgets a copy this
 * mount never confirmed and keeps one it did; `loading` in the result is exactly
 * `loading` or `revalidating`, the meaning every existing reader relies on.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
    // Not `seeded` any more: the wait for this mount's own read is over, and
    // the gate judges the kept catalog (with the error beside it) instead of
    // holding a pick on a read that is no longer in flight.
    case 'failed': return event.keepShown && current.catalog
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
/**
 * One bounded entry per scope: the last-known copy, and the sequence of the
 * newest read STARTED for it — only that read's answer may become the copy,
 * so a slow older read never overwrites a newer one. The sequence lives in
 * the entry so the cap bounds both.
 */
interface Remembered { catalog?: McpCatalog; seq: number }
const lastKnown = new WeakMap<McpPort, Map<string, Remembered>>();
/** Scopes kept per port. A person opens a few tasks, not hundreds; the oldest goes first. */
const LAST_KNOWN_SCOPES = 16;
function entriesFor(port: McpPort): Map<string, Remembered> {
  let scopes = lastKnown.get(port);
  if (!scopes) { scopes = new Map(); lastKnown.set(port, scopes); }
  return scopes;
}
function lastKnownCopy(port: McpPort, scope: string): McpCatalog | undefined {
  return lastKnown.get(port)?.get(scope)?.catalog;
}
function startRead(port: McpPort, scope: string): number {
  const scopes = entriesFor(port);
  const entry = scopes.get(scope);
  const seq = (entry?.seq ?? 0) + 1;
  scopes.delete(scope);
  scopes.set(scope, { ...(entry?.catalog ? { catalog: entry.catalog } : {}), seq });
  for (const oldest of scopes.keys()) { if (scopes.size <= LAST_KNOWN_SCOPES) break; scopes.delete(oldest); }
  return seq;
}
/** Settle the read numbered `seq`: keep its answer, or forget the copy. A superseded read changes nothing. */
function settle(port: McpPort, scope: string, seq: number, catalog: McpCatalog | undefined) {
  const entry = lastKnown.get(port)?.get(scope);
  if (!entry || entry.seq !== seq) return;
  entry.catalog = catalog;
}

export function useMcpCatalog(targetId?: string, teamMemberId?: string, options?: { lastKnown?: boolean }) {
  const { port, revision, refresh } = useContext(Context);
  const scope = JSON.stringify([targetId, teamMemberId]);
  const keep = options?.lastKnown === true;
  const seed = keep && port ? lastKnownCopy(port, scope) : undefined;
  // The scope this mount has had its OWN answer for, if any.
  const answered = useRef<string | null>(null);
  const [state, setState] = useState<{ port: McpPort | null; scope: string; revision: number; snapshot: CatalogSnapshot }>(
    () => ({ port, scope, revision, snapshot: step(NOTHING, { type: 'read', seed }) }));
  useEffect(() => {
    if (!port) return;
    let active = true;
    const start = keep ? lastKnownCopy(port, scope) : undefined;
    setState(previous => ({ port, scope, revision,
      snapshot: step(previous.port === port && previous.scope === scope ? previous.snapshot : NOTHING, { type: 'read', seed: start }) }));
    const seq = keep ? startRead(port, scope) : 0;
    void port.catalog(targetId, teamMemberId).then(
      catalog => {
        // Remembered even when this mount is gone — a card closed before its
        // first read landed is exactly the one whose next open needs the seed —
        // but only if no newer read for the scope has started since.
        if (keep) settle(port, scope, seq, catalog);
        if (!active) return;
        answered.current = scope;
        setState(previous => ({ ...previous, snapshot: step(previous.snapshot, { type: 'answered', catalog }) }));
      },
      // A failure keeps the copy only when this mount confirmed it: a re-read
      // that fails after this mount's own answer keeps showing (and keeping)
      // it. A copy this mount never confirmed is forgotten, so a target the
      // server now refuses stops seeding reopen after reopen.
      () => {
        if (keep && answered.current !== scope) settle(port, scope, seq, undefined);
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
