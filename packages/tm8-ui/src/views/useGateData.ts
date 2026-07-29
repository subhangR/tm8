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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CollectionQuery,
  ExecutionSpawnInput,
  EntityDetail,
  EntityId,
  MessageView,
  PostMessageInput,
  EntitySummary,
  MenuConfig,
  SpaceId,
  SpaceSummary,
} from '@tm8/contract';
import type { ConnectionState, Seam, SessionLiveness } from '../data/seam';
import { browserWebSocketFactory, createFixtureSeam, createRealSeam } from '../data';
import { isRealSeamEnabled } from './realSeamFlag';
import { createDomainStore, projectRows, type DomainStoreHandle } from '../data/project/domain-store';
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
  /** The composer's dispatcher (Surface Audit): seam postMessage, then the
      anchor's thread re-read so the echo is on screen, not implied. */
  postMessage: (input: PostMessageInput) => Promise<void>;
  /** The thread for an entity, hydrated by pull(). Absent = no read ran. */
  messagesOf: (id: string) => readonly MessageView[] | undefined;
  seam: Seam;
  domain: DomainStoreHandle;
}

/** Kinds the gate screen hydrates up front: the two workspace side panels. */
export interface GateOptions {
  leftKind: string;
  rightKind: string;
  /**
   * THE SEAM INJECTION PORT.
   *
   * Omitted — which is what every screen does — the hook constructs the seam
   * the flag selects, once, for the app's lifetime. Passing one is how a test
   * drives the event stream by hand: `onEvent` is the input side of the whole
   * live-update loop, and with no way to feed it, the only assertions
   * available are about reads, which is exactly the half that was already
   * working. Read once, on the same first render as the flag, for the same
   * reason: two seams would mean two event streams and one divided cache.
   */
  seam?: Seam;
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
   * REAL BY DEFAULT since 2026-07-29 (`realSeamFlag.ts` carries the rules and
   * the reasoning): an un-opted browser session talks to the node. There is no
   * fall-back path — if the node is unreachable the boot read below rejects
   * and `bootError` holds the reason, because quietly substituting fixtures
   * would put invented entities on screen wearing the real ones' chrome.
   */
  const seamRef = useRef<Seam | null>(null);
  if (seamRef.current === null) {
    seamRef.current = options.seam
      ? options.seam
      : isRealSeamEnabled()
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
  /**
   * ROWS ARE IDS NOW, NOT SUMMARIES — and that one change is what closed the
   * live loop.
   *
   * This used to hold the summaries a read returned. A cached row was then a
   * PHOTOGRAPH: correct at read time and frozen after it, so the only way to
   * see a change was to take the photograph again, which is why every update
   * path in this file was a re-read. The event stream reduced correctly into
   * the domain store the whole time and nothing rendered it.
   *
   * Splitting the two questions fixes it. This map answers the one the store
   * genuinely cannot — WHICH entities the server put in this (kind, filter)
   * list, in what order — and the store answers WHAT each of them currently
   * is. `projectRows` joins them on every render, so an event that changes an
   * entity changes the list, with no read and nothing to invalidate.
   */
  const [rows, setRows] = useState<Record<string, readonly EntityId[]>>({});
  const [threads, setThreads] = useState<Record<string, readonly MessageView[]>>({});
  const [activity] = useState<Readonly<Record<string, boolean>>>({});

  /**
   * The event stream's own projection, subscribed. `useSyncExternalStore` and
   * not a `useEffect` + `setState` mirror: a mirror renders one frame behind
   * and tears under concurrent rendering, and the whole claim of this file is
   * that the screen agrees with the stream.
   */
  const entities = useSyncExternalStore(
    domain.store.subscribe,
    () => domain.store.getState().entities,
  );
  const details = useSyncExternalStore(
    domain.store.subscribe,
    () => domain.store.getState().details,
  );

  /** Every read lands in the store FIRST, then leaves its ordering here. Both
      halves matter: skipping the ingest would leave `projectRows` joining ids
      against entities it has never seen, and the list would render empty. */
  const absorb = useCallback(
    (key: string, items: readonly EntitySummary[]) => {
      domain.store.getState().ingestSummaries([...items]);
      setRows((current) => ({ ...current, [key]: items.map((item) => item.id) }));
    },
    [domain],
  );

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
        absorb(`${kind}::*`, result.page.items);
      };
      await Promise.all([load(options.leftKind), load(options.rightKind)]);
    },
    [seam, options.leftKind, options.rightKind, absorb],
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
    () =>
      seam.onResync((space) => {
        if (space !== spaceId) return;
        // Detail reads are re-armed with everything else: a resync means the
        // catch-up gap could have swallowed anything, including whatever made
        // a detail read fail.
        pulled.current.clear();
        void hydrate(space);
      }),
    [seam, spaceId, hydrate],
  );

  const livenessOf = useCallback(
    (id: string): SessionLiveness => {
      // O(1) off the projection, where it used to be a flatten-and-scan of
      // every cached list. Same evidence, one lookup — and the projection is
      // the fresher of the two, so a session whose status just changed is
      // asked about with the status the node last sent.
      const summary = entities[id as EntityId];
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
    [seam, entities],
  );

  /**
   * Hydrate a kind the viewer has just selected. The side-panel selectors are
   * live (LLD §3.1), so a kind can be asked for that boot never loaded — this
   * fetches it once and leaves it cached. Re-entrant by the `rows` guard, so a
   * re-render mid-flight does not issue a second query.
   */
  const inFlight = useRef(new Set<string>());
  /** Ids whose detail read has been issued. See `pull` for why it is a ref. */
  const pulled = useRef(new Set<string>());
  const ensureKind = useCallback(
    (kind: string) => {
      if (!spaceId || rows[`${kind}::*`] || inFlight.current.has(kind)) return;
      inFlight.current.add(kind);
      const query = { spaceId, kinds: [kind] } as unknown as CollectionQuery;
      void seam
        .query(query)
        .then((result) => absorb(`${kind}::*`, result.page.items))
        .catch(() => {
          // A kind that will not load renders as an honestly empty panel
          // rather than a spinner that never resolves.
          setRows((current) => ({ ...current, [`${kind}::*`]: [] }));
        })
        .finally(() => inFlight.current.delete(kind));
    },
    [seam, spaceId, rows, absorb],
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

  /* Surface Audit 2026-07-29: the composer rendered ENABLED and wired to
     nothing — inviting an action it could not perform, the worst honesty
     class on the board. Same passthrough shape as spawn: the seam command,
     then idempotent re-hydration so the thread shows the echo. */
  const postMessage = useCallback(
    async (input: PostMessageInput) => {
      await seam.commands.postMessage(input);
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
   *
   * AND IT IS LIVE. The key still decides WHICH read answered; `projectRows`
   * decides what those rows currently say and whether the stream has added
   * one. An unread key is still `[]` and still schedules its read — the
   * projection augments the read path, it never stands in for it, or a kind
   * nobody has asked for would render as confidently empty.
   */
  const cacheKey = (kind: string, filter: unknown): string =>
    `${kind}::${filter === undefined ? '*' : stableKey(filter)}`;

  const pending = useRef(new Set<string>());
  const [pendingTick, setPendingTick] = useState(0);

  /**
   * ONE PROJECTION PER KEY PER DATA GENERATION.
   *
   * `projectRows` builds a new array, and `rowsFor` is called from render — so
   * without this the same key would hand every consumer a fresh identity on
   * every render, and the `useMemo`/`useEffect` deps downstream (WorkspaceView's
   * roster, GateApp's palette, useHomeData's three lists) would churn without
   * end. The Map is re-created only when the ids or the entities change, which
   * makes "the data did not change" and "the array is the same array" the same
   * statement. Pinned by a test, because the failure is a render loop nobody
   * would attribute to this file.
   */
  const projected = useMemo(() => new Map<string, readonly EntitySummary[]>(), [rows, entities, spaceId]);

  const rowsFor = useCallback(
    (kind: string) =>
      (filter?: unknown): readonly EntitySummary[] => {
        const key = cacheKey(kind, filter);
        const ordered = rows[key];
        if (ordered === undefined) {
          // Record the miss; the effect below performs the read. Requesting
          // from inside render must never dispatch, so this only marks intent.
          if (!pending.current.has(key)) {
            pending.current.add(key);
            queueMicrotask(() => setPendingTick((n) => n + 1));
          }
          return EMPTY_ROWS;
        }
        const hit = projected.get(key);
        if (hit) return hit;
        const out = projectRows({ ordered, entities, kind, spaceId, filter });
        projected.set(key, out);
        return out;
      },
    [rows, entities, spaceId, projected],
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
        .then((result) => absorb(key, result.page.items))
        .catch(() => setRows((current) => ({ ...current, [key]: [] })));
    }
  }, [ready, spaceId, seam, pendingTick, absorb]);

  const detailOf = useCallback((id: string) => details[id as EntityId], [details]);

  const pull = useCallback(
    async (id: string) => {
      if (pulled.current.has(id)) return;
      pulled.current.add(id);
      const [detail, thread] = await Promise.all([
        seam.entity(id as never).catch(() => undefined),
        // The thread rides the same pull: a composer that posts into a tab
        // that never READS is only half a fix (Surface Audit). A read error
        // leaves the id absent — the tab renders its designed empty state
        // rather than a fabricated zero.
        seam.messages(id as never).catch(() => undefined),
      ]);
      /* THE DETAIL GOES INTO THE STORE, not beside it. `entity.upsert` then
         overlays the fresher envelope onto it (reducers.mergeSummary keeps the
         heavy sections), so an open panel shows a title someone else changed
         without anyone re-reading — the same loop the lists get, for free.
         The re-entrancy guard moved to a ref because the store's `details` is
         no longer this hook's state: guarding on it would re-arm the read
         every time an event touched the entity. */
      /* A FAILED READ IS NOT RE-ARMED HERE, and that is deliberate now that
         the default seam is a real node. `renderPanel` calls `pull` FROM
         RENDER whenever the detail is missing, so clearing the guard on
         failure turns one unreadable entity into an unbounded request loop
         against the node — the fixture seam could never fail, so the shape was
         invisible before the default flipped. The id stays claimed; `onResync`
         clears the whole set, which is the same "catch-up integrity was lost,
         re-run the reads" rule the rest of this hook obeys. */
      if (detail) domain.store.getState().ingestDetail(detail);
      if (thread) setThreads((current) => ({ ...current, [id]: thread.items }));
    },
    [seam, domain],
  );

  /** Post, then re-read THAT anchor's thread so the echo is visible truth. */
  const postAndRefresh = useCallback(
    async (input: PostMessageInput) => {
      await postMessage(input);
      const anchor = input.anchorIds[0];
      if (!anchor) return;
      const thread = await seam.messages(anchor as never).catch(() => undefined);
      if (thread) setThreads((current) => ({ ...current, [anchor]: thread.items }));
    },
    [postMessage, seam],
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
      postMessage: postAndRefresh,
      messagesOf: (id: string) => threads[id],
      seam,
      domain,
      pull: (id: string) => void pull(id),
    }),
    [ready, spaceId, spaces, menu, connection, bootError, liveIds, livenessOf, rowsFor, detailOf, activity, ensureKind, spawn, postAndRefresh, threads, seam, domain, pull],
  );

  return data;
}
