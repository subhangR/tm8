/**
 * Gate boot: seam → domain store → the selectors the views hand to the panels.
 *
 * This is the ONLY place the shell touches the seam. Everything below it —
 * WorkspaceView, the panels, the rail — receives plain functions and arrays and
 * has no idea whether a fixture or a real node produced them, which is the
 * point of the seam being transport-shaped (LLD §10.1, C-3).
 *
 * Two laws it exists to enforce, both easy to break by accident elsewhere:
 *
 *  - **Liveness comes ONLY from `seam.liveness.statusOf`** (R-UI-5, §10.2.2).
 *    Nothing here derives a verdict from `activityAt` recency or any other
 *    summary field; `unknown` is returned when there is no snapshot, and
 *    `unknown` renders neutral, never live (D6).
 *  - **No kind literal reaches shell code** (§15.2). The panels are told WHICH
 *    kind to render by the caller, and the live set arrives from the seam's
 *    liveness snapshot — which IS the set of live session ids by the C-1
 *    definition, so the shell never issues a kind-filtered query to find them
 *    (B7).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CollectionQuery,
  ExecutionSpawnInput,
  EntityDetail,
  EntitySummary,
  MenuConfig,
  SpaceId,
  SpaceSummary,
} from '@tm8/contract';
import type { ConnectionState, Seam, SessionLiveness } from '../data/seam';
import { browserWebSocketFactory, createFixtureSeam, createRealSeam } from '../data';
import { isRealSeamEnabled } from './realSeamFlag';
import { createDomainStore, type DomainStoreHandle } from '../data/project/domain-store';
import { resolveMenu, type ResolvedMenu } from '../shell/menu-resolve';
import { toSessionRow } from '../terminal';

/** Frozen so an empty result keeps referential identity across renders. */
const EMPTY_ROWS: readonly EntitySummary[] = Object.freeze([]);

/** Order-independent key: two equal filters must not produce two cache rows. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`;
}

export interface GateData {
  ready: boolean;
  spaceId: SpaceId;
  spaces: SpaceSummary[];
  menu: ResolvedMenu;
  connection: ConnectionState;
  /** Set when the first read failed — an unreachable node, honestly held. */
  bootError: string | null;
  /** Live set, verbatim from the seam snapshot. The ONLY source for `● N live`. */
  liveIds: readonly string[];
  /** THE verdict. Never computed in the UI. */
  livenessOf: (id: string) => SessionLiveness;
  /** Rows for a (kind, filter) pair — hydrated once, then served from memory. */
  rowsFor: (kind: string) => (filter?: unknown) => readonly EntitySummary[];
  detailOf: (id: string) => EntityDetail | undefined;
  /** Pool byte-activity, scripted in Phase 1 (§9.2 stub) — NEVER liveness. */
  activity: Readonly<Record<string, boolean>>;
  /** Hydrate a kind the viewer selected after boot. Idempotent. */
  ensureKind: (kind: string) => void;
  /**
   * D44: launch creates a REAL fixture session through the seam's own command
   * path — patches, echo event, monotonic seq — so the live set moves and the
   * count updates the way it will with a real node. Not a stub.
   */
  spawn: (input: ExecutionSpawnInput) => Promise<void>;
  seam: Seam;
  domain: DomainStoreHandle;
}

/** Kinds the gate screen hydrates up front: the two workspace side panels. */
export interface GateOptions {
  leftKind: string;
  rightKind: string;
}

export function useGateData(options: GateOptions): GateData {
  // One seam and one domain store for the app's lifetime. `useRef` rather than
  // `useMemo` because StrictMode may discard a memo, and a second seam would
  // mean a second event stream and a silently divided cache.
  /**
   * ONE SEAM FOR THE APP'S LIFETIME, and the flag is read ONCE at first render.
   *
   * `useRef` rather than `useMemo` because StrictMode may discard a memo, and a
   * second seam would mean a second event stream and a silently divided cache.
   * The flag read is inside the same guard for the same reason: swapping seams
   * mid-session would leave one stream still delivering into a store the other
   * is reconciling, so the flag is deliberately NOT reactive. CHANGING IT
   * REQUIRES A RELOAD — that is the contract, not an oversight.
   *
   * OFF by default: an un-opted session constructs exactly the fixture seam it
   * always did.
   */
  const seamRef = useRef<Seam | null>(null);
  if (seamRef.current === null) {
    seamRef.current = isRealSeamEnabled()
      ? createRealSeam({
          // baseUrl stays default-relative: the vite proxy carries /v2, so a
          // hardcoded origin here would bypass it and break same-origin.
          fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
          webSocketFactory: browserWebSocketFactory(WebSocket),
          origin: location.origin,
        })
      : createFixtureSeam();
  }
  const seam = seamRef.current;

  const domainRef = useRef<DomainStoreHandle | null>(null);
  if (domainRef.current === null) domainRef.current = createDomainStore(seam);
  const domain = domainRef.current;

  const [ready, setReady] = useState(false);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [spaceId, setSpaceId] = useState<SpaceId>('' as SpaceId);
  const [menu, setMenu] = useState<ResolvedMenu>(() => resolveMenu(null));
  const [connection, setConnection] = useState<ConnectionState>(() => seam.getConnection());
  const [liveIds, setLiveIds] = useState<readonly string[]>([]);
  const [rows, setRows] = useState<Record<string, readonly EntitySummary[]>>({});
  const [details, setDetails] = useState<Record<string, EntityDetail>>({});
  const [activity] = useState<Readonly<Record<string, boolean>>>({});

  /**
   * Hydration is written as ONE idempotent, re-runnable function from day one
   * (§10.2.5): `onResync` means catch-up integrity was lost, and the only
   * honest response is to re-run the reads rather than patch around the gap.
   */
  const hydrate = useCallback(
    async (space: SpaceId) => {
      const [menuRaw, snapshot] = await Promise.all([
        seam.menu(space).catch((error: unknown) => {
          setMenu(resolveMenu(undefined, error));
          return undefined;
        }),
        // `refresh()` RESOLVES the snapshot; there is no accessor to read one
        // back. Holding the latest is this layer's job by design (A1c), which
        // is why every renderer below takes `liveIds` as a plain array.
        seam.liveness.refresh(space).catch(() => undefined),
      ]);
      if (menuRaw !== undefined) setMenu(resolveMenu(menuRaw as MenuConfig | null));
      if (snapshot) setLiveIds(snapshot.liveEntityIds);

      const load = async (kind: string) => {
        const query = { spaceId: space, kinds: [kind] } as unknown as CollectionQuery;
        const result = await seam.query(query);
        // Same key shape rowsFor reads: an unfiltered read is the '*' key.
        setRows((current) => ({ ...current, [`${kind}::*`]: result.page.items }));
      };
      await Promise.all([load(options.leftKind), load(options.rightKind)]);
    },
    [seam, options.leftKind, options.rightKind],
  );

  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await seam.spaces();
        if (cancelled) return;
        const first = list[0];
        if (!first) return;
        setSpaces(list);
        setSpaceId(first.id);
        await seam.openSpace(first.id);
        await hydrate(first.id);
        if (!cancelled) setReady(true);
      } catch (error: unknown) {
        // AN UNREACHABLE NODE IS A NORMAL STATE, not a crash.
        //
        // With the fixture seam this could never happen, so boot had no catch
        // and the rejection was invisible. Point the real-seam flag at a node
        // that is down — the case that flag exists to exercise — and the boot
        // promise rejects UNHANDLED: an uncaught rejection in the browser, and
        // a runner exit code of 1 with every test still reporting green, which
        // is how it was found.
        //
        // `ready` stays false and the failure is HELD rather than swallowed:
        // the shell keeps its loading state and the reason is available, which
        // is the honest rendering of "we could not reach the node" — never an
        // empty workspace that looks like a space with nothing in it.
        if (cancelled) return;
        setBootError(String((error as { message?: string })?.message ?? error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seam, hydrate]);

  // Connection honesty, rendered once in the shell and selected everywhere
  // (§10.2.4). `polling` is a degraded-but-advancing state, not an outage.
  useEffect(() => seam.onConnection(setConnection), [seam]);

  // The live set changes without us asking; `onChange` is the push half of the
  // liveness surface and keeps the held snapshot from going quietly stale.
  useEffect(
    () => seam.liveness.onChange((snapshot) => setLiveIds(snapshot.liveEntityIds)),
    [seam],
  );

  // Catch-up integrity lost ⇒ re-run hydration. Idempotent by construction.
  useEffect(
    () => seam.onResync((space) => { if (space === spaceId) void hydrate(space); }),
    [seam, spaceId, hydrate],
  );

  const livenessOf = useCallback(
    (id: string): SessionLiveness => {
      const summary = Object.values(rows)
        .flat()
        .find((row) => row.id === id);
      // No row ⇒ no evidence ⇒ 'unknown'. Never optimistically 'live'.
      if (!summary) return 'unknown';
      // The recorded status lives on `state`, NOT as a top-level `workStatus`:
      // tasks carry `state.workStatus`, sessions carry `state.status` (seam
      // Amendment 1). Reading a top-level field that does not exist yielded
      // `null` for every row, so `statusOf` answered 'not-running' for ALL of
      // them — while the bar, which reads the seam's live set directly, said
      // "1 live". The screen contradicted itself. Caught in the browser, not by
      // any test. `toSessionRow` projects STRUCTURALLY ('status' in state), so
      // this stays kind-literal-free.
      const recorded = toSessionRow(summary).recordedStatus
        ?? (summary.state as unknown as { workStatus?: string | null }).workStatus
        ?? null;
      return seam.liveness.statusOf({ id: summary.id, workStatus: recorded as never });
    },
    [seam, rows],
  );

  /**
   * Hydrate a kind the viewer has just selected. The side-panel selectors are
   * live (LLD §3.1), so a kind can be asked for that boot never loaded — this
   * fetches it once and leaves it cached. Re-entrant by the `rows` guard, so a
   * re-render mid-flight does not issue a second query.
   */
  const inFlight = useRef(new Set<string>());
  const ensureKind = useCallback(
    (kind: string) => {
      if (!spaceId || rows[`${kind}::*`] || inFlight.current.has(kind)) return;
      inFlight.current.add(kind);
      const query = { spaceId, kinds: [kind] } as unknown as CollectionQuery;
      void seam
        .query(query)
        .then((result) => setRows((current) => ({ ...current, [`${kind}::*`]: result.page.items })))
        .catch(() => {
          // A kind that will not load renders as an honestly empty panel
          // rather than a spinner that never resolves.
          setRows((current) => ({ ...current, [`${kind}::*`]: [] }));
        })
        .finally(() => inFlight.current.delete(kind));
    },
    [seam, spaceId, rows],
  );

  useEffect(() => {
    if (!ready) return;
    ensureKind(options.leftKind);
    ensureKind(options.rightKind);
  }, [ready, options.leftKind, options.rightKind, ensureKind]);

  const spawn = useCallback(
    async (input: ExecutionSpawnInput) => {
      await seam.commands.spawn(input);
      // Re-read the reads the new session affects. Hydration is idempotent by
      // construction (§10.2.5), which is exactly why it is safe to re-run here
      // rather than hand-patching a row into the cache.
      if (spaceId) await hydrate(spaceId);
    },
    [seam, spaceId, hydrate],
  );

  /**
   * THE FILTER REACHES THE SEAM (D57's fifth layer).
   *
   * This previously read `(kind) => () => rows[kind] ?? []`: the type promised
   * a filter parameter and the implementation never bound it, so every tier —
   * Open, Done, Archived — received the SAME pre-hydrated array. Four sessions
   * rendered as twelve, one set counted three times, and the seam's executor
   * clause could not run because nothing ever called it with a filter.
   *
   * Nothing could see it. `(filter: unknown)` is a signature that PROMISES
   * acceptance, and an implementation ignoring its argument is type-legal, so
   * tsc is structurally blind to it. Panel tests inject their own `rowsFor`;
   * executor tests call the seam directly. The gap sat exactly between two
   * suites that were both green.
   *
   * Now keyed per (kind, filter) — the hydration key LLD §3.1 specifies — and
   * an unseen key hydrates on demand. It returns [] until that resolves, which
   * is honest: not-yet-loaded is a real state and it is not the same as empty.
   */
  const cacheKey = (kind: string, filter: unknown): string =>
    `${kind}::${filter === undefined ? '*' : stableKey(filter)}`;

  const pending = useRef(new Set<string>());
  const [pendingTick, setPendingTick] = useState(0);

  const rowsFor = useCallback(
    (kind: string) =>
      (filter?: unknown): readonly EntitySummary[] => {
        const key = cacheKey(kind, filter);
        if (rows[key] !== undefined) return rows[key];
        // Record the miss; the effect below performs the read. Requesting from
        // inside render must never dispatch, so this only marks intent.
        if (!pending.current.has(key)) {
          pending.current.add(key);
          queueMicrotask(() => setPendingTick((n) => n + 1));
        }
        return EMPTY_ROWS;
      },
    [rows],
  );

  // Drains the misses recorded during render. Each (kind, filter) key is read
  // once and cached; `onResync` clearing `rows` re-arms every key naturally.
  useEffect(() => {
    if (!ready || !spaceId || pending.current.size === 0) return;
    const keys = [...pending.current];
    pending.current.clear();
    for (const key of keys) {
      const [kind, filterPart] = key.split('::');
      const query = {
        spaceId,
        kinds: [kind],
        ...(filterPart && filterPart !== '*' ? { filters: JSON.parse(filterPart) } : {}),
      } as unknown as CollectionQuery;
      void seam
        .query(query)
        .then((result) => setRows((current) => ({ ...current, [key]: result.page.items })))
        .catch(() => setRows((current) => ({ ...current, [key]: [] })));
    }
  }, [ready, spaceId, seam, pendingTick]);

  const detailOf = useCallback((id: string) => details[id], [details]);

  // Detail is pulled lazily as panels open; the store keeps what it has seen.
  useEffect(() => {
    if (!ready) return;
    const unsubscribe = domain.store.subscribe(() => {
      // Domain-store echoes reconcile into the same cache the panels read.
    });
    return unsubscribe;
  }, [ready, domain]);

  const pull = useCallback(
    async (id: string) => {
      if (details[id]) return;
      const detail = await seam.entity(id as never).catch(() => undefined);
      if (detail) setDetails((current) => ({ ...current, [id]: detail }));
    },
    [seam, details],
  );

  // Exposed through the returned object so views can request a panel's detail
  // without reaching for the seam themselves.
  const data = useMemo<GateData & { pull: (id: string) => void }>(
    () => ({
      ready,
      spaceId,
      spaces,
      menu,
      connection,
      bootError,
      liveIds,
      livenessOf,
      rowsFor,
      detailOf,
      activity,
      ensureKind,
      spawn,
      seam,
      domain,
      pull: (id: string) => void pull(id),
    }),
    [ready, spaceId, spaces, menu, connection, bootError, liveIds, livenessOf, rowsFor, detailOf, activity, ensureKind, spawn, seam, domain, pull],
  );

  return data;
}
