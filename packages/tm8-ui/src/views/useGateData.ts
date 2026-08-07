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
  ActorSummary,
  AttentionRequestMutationResult,
  CollectionQuery,
  CommandResult,
  EdgeView,
  ExecutionSpawnInput,
  EntityDetail,
  EntityId,
  MessageView,
  PostMessageInput,
  EntitySummary,
  MenuConfig,
  SpaceId,
  SpaceKindCounts,
  SpaceSummary,
  ProjectResource,
} from '@tm8/contract';
import { CollabError, launchModel } from '@tm8/contract';
import { subscribeToSession } from '../auth/session';
import type { ConnectionState, LivenessSnapshot, Seam, SessionLiveness } from '../data/seam';
import {
  browserWebSocketFactory,
  createFixtureSeam,
  createRealSeam,
  type RealControls,
} from '../data';
import { isRealSeamEnabled } from './realSeamFlag';
import { createDomainStore, projectRows, selectConnectionsOf, type DomainStoreHandle } from '../data/project/domain-store';
import {
  CACHED_LAUNCH_KINDS,
  nodeKeyOf,
  readLaunchCache,
  writeLaunchCache,
} from '../data/launch-cache';
import { readLastSpace, writeLastSpace } from './last-place';
import { resolveMenu, type ResolvedMenu } from '../shell/menu-resolve';
import { toSessionRow } from '../terminal';
import { terminalActivitySource, useTerminalActivityMap } from '../terminal/activity';
import { useMessagePulses, type MessagePulse } from '../panels/list/useMessagePulses';
import type { BoardSnapshot } from '../panels';
import {
  CORE_CHAT_LAUNCH_PRESENTATION,
  type LaunchCapacity,
  type LaunchProfile,
  type LaunchProject,
  type LaunchTeammate,
} from '../domain/launch';
import { representedThreadMessageCount } from './message-thread';

/** Frozen so an empty result keeps referential identity across renders. */
const EMPTY_ROWS: readonly EntitySummary[] = Object.freeze([]);

/**
 * How long the rail's counters wait out an event burst before re-reading.
 *
 * Long enough that a spawn or an agent's run of writes costs ONE query rather
 * than dozens; short enough that a number the user just caused to change has
 * settled by the time they look back at the rail.
 */
const COUNTS_DEBOUNCE_MS = 400;

/**
 * How many times one entity's detail or thread may be re-read after a FAILED
 * read. Eight attempts, spaced by `readRetryDelayMs`, spans several minutes —
 * deliberately longer than the 503 storm that produced this defect, because a
 * budget that expires DURING the storm strands the panel exactly as the old
 * never-retry rule did, just more slowly.
 *
 * The delay is consulted from RENDER, not from a timer: `renderPanel` calls
 * `pull` whenever the detail is missing, so the next render at or after
 * `nextAt` IS the retry. Nothing here schedules work of its own.
 */
const READ_MAX_ATTEMPTS = 8;

/**
 * Did the node give a FINAL answer about this entity? A 404/403/400 is not a
 * transient condition — the node looked and told us. Re-asking cannot change
 * it, and re-asking from a render-time caller is the unbounded loop wearing a
 * different hat. Anything else (a served 503, a proxy 502/504, an unreachable
 * node, the http client's own timeout abort) is worth another look.
 */
function isTerminalReadError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'not_found' || code === 'forbidden' || code === 'invalid_input';
}

/**
 * Backoff for a failed detail/thread read, on the same principle as
 * `bootRetryDelayMs`: an OVERLOADED node must be probed slowly, because the
 * retry is itself the load that is keeping it down. An unreachable node or a
 * timeout costs it nothing, so that ladder starts fast and stays tighter.
 */
function readRetryDelayMs(attempt: number, error: unknown): number {
  return isOverloadResponse(error)
    ? Math.min(3_000 * 2 ** (attempt - 1), 60_000)
    : Math.min(700 * 2 ** (attempt - 1), 15_000);
}

/**
 * One failed read's budget. `terminal` records that the node gave a FINAL
 * answer, which is what keeps a 404 from being forgiven by an unrelated
 * success later.
 */
interface ReadFailure {
  attempts: number;
  nextAt: number;
  terminal: boolean;
}

/** Detail and thread budgets are separate records under one map. */
function readKey(half: 'd' | 'm', id: string): string {
  return `${half}:${id}`;
}

function readBlocked(failures: Map<string, ReadFailure>, key: string): boolean {
  const failure = failures.get(key);
  if (failure === undefined) return false;
  return failure.attempts >= READ_MAX_ATTEMPTS || Date.now() < failure.nextAt;
}

function recordReadFailure(
  failures: Map<string, ReadFailure>,
  key: string,
  error: unknown,
): void {
  // A terminal answer spends the whole budget at once: the node told us what it
  // knows and asking again cannot change it. Retrying a 404 from a render-time
  // caller is the unbounded loop with extra steps.
  const terminal = isTerminalReadError(error);
  const attempts = terminal ? READ_MAX_ATTEMPTS : (failures.get(key)?.attempts ?? 0) + 1;
  failures.set(key, { attempts, terminal, nextAt: Date.now() + readRetryDelayMs(attempts, error) });
}

/**
 * A read just succeeded, so the node serves reads again. Budgets spent against
 * a node that was failing are evidence from a world that no longer exists —
 * drop them so those panels get another chance. This, rather than a socket
 * reconnect, is the signal that matches the failure this exists for: the WS
 * heartbeat never touches the DB pool, so the socket typically SURVIVES the
 * 503 storm that spends these budgets.
 */
function forgiveExhaustedReads(failures: Map<string, ReadFailure>): void {
  for (const [key, failure] of failures) {
    if (!failure.terminal && failure.attempts >= READ_MAX_ATTEMPTS) failures.delete(key);
  }
}

export interface GateGraphData {
  nodes: readonly EntitySummary[];
  edges: readonly EdgeView[];
  loading: boolean;
  error: string | null;
  now: string;
  refresh: () => void;
}

/** Order-independent key: two equal filters must not produce two cache rows. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`;
}

/**
 * Did the node ANSWER this failure, and was the answer "I am overloaded"?
 *
 * The distinction the boot retry runs on. `CollabError.status` cannot carry
 * it — the class recomputes 503 from the code, so a connection refused and a
 * served 503 look identical there. Only `details.httpStatus` (set by the
 * transport exactly when a response arrived) records that the node was
 * reachable and drowning rather than absent. 502/504 are the proxy saying the
 * same thing on the backend's behalf.
 */
function isOverloadResponse(error: unknown): boolean {
  const details = (error as { details?: Record<string, unknown> } | null | undefined)?.details;
  const status = details?.['httpStatus'];
  return status === 502 || status === 503 || status === 504;
}

/**
 * Backoff for the boot reads, and THE FIX for the request storm's feedback
 * half: against an OVERLOADED node the retry itself is the load.
 *
 * An unreachable node costs nothing to probe — a fast 1s→15s ladder gets the
 * workspace back the moment the node returns, and "retry forever" stays
 * correct because unreachable is a normal, transient state (restart, sleep,
 * a blip). A node answering 503 is the opposite case: it is up, saturated,
 * and every request we add holds its pool down. Measured on staging before
 * this existed: boot retries were ~50 req/s sustained and the node never
 * converged, because the retry rate exceeded the drain rate. So overload
 * starts at 5s and backs off to a 60s ceiling — still forever, never a
 * permanent error card, but slow enough that the node can drain.
 */
function bootRetryDelayMs(attempt: number, error: unknown): number {
  return isOverloadResponse(error)
    ? Math.min(5_000 * 2 ** attempt, 60_000)
    : Math.min(1_000 * 2 ** attempt, 15_000);
}

/**
 * `Promise.all` with a concurrency bound, for the boot reads that genuinely
 * need one request per item. The pool behind `/v2` is small (8 by default)
 * and shared by every tab; an unbounded fan-out of N kind queries plus one
 * connections read per teammate is how boot saturated it. Two at a time keeps
 * boot latency close to parallel while leaving the pool room to serve
 * everything that is not us.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Boot's request-concurrency bound for per-item reads. See `mapLimit`. */
const BOOT_READ_CONCURRENCY = 2;

/**
 * Kinds that are OPTION SETS rather than paged lists — the teammate picker and
 * the interaction-profile picker have to offer every row that exists, so their
 * boot read asks for the whole set instead of taking the server default.
 */
const LAUNCH_SOURCE_KINDS = new Set(['team_member', 'interaction_profile']);

/** The server's own `MAX_LIMIT`. Asking for more is an invalid_input refusal. */
const MAX_COLLECTION_LIMIT = 200;

/** Trailing debounce for persisting the launch cache. See its effect. */
const LAUNCH_CACHE_DEBOUNCE_MS = 1000;

export interface GateData {
  ready: boolean;
  spaceId: SpaceId;
  spaces: SpaceSummary[];
  /** Real membership of the active space, never inferred from result authors. */
  members: readonly ActorSummary[];
  /** The active identity's member actor in this space, when one is bound. */
  viewerActor: ActorSummary | null;
  menu: ResolvedMenu;
  connection: ConnectionState;
  /** Set when the first read failed — an unreachable node, honestly held. */
  bootError: string | null;
  /**
   * The active server ANSWERED the boot read with `unauthenticated`. A node
   * that refuses the credential is a different fact from a node that cannot be
   * reached: the cure is a sign-in, not a retry — so while this is set the
   * boot loop waits on the session store instead of the backoff timer, and the
   * host renders the sign-in frame for this server instead of the retry card.
   */
  authRequired: boolean;
  /** Live set, verbatim from the seam snapshot. The ONLY source for `● N live`. */
  liveIds: readonly string[];
  /** THE verdict. Never computed in the UI. */
  livenessOf: (id: string) => SessionLiveness;
  /** Rows for a (kind, filter) pair — hydrated once, then served from memory. */
  rowsFor: (kind: string) => (filter?: unknown) => readonly EntitySummary[];
  /**
   * The BOARD's grouped read for a (kind, filter, groupBy) triple (A2).
   *
   * Same `collections.query`, plus `groupBy` — columns are the server's
   * `CollectionResult.groups`; the client never groups (L3). `undefined`
   * means in flight (the board renders skeletons). Kept current from the
   * durable stream: any event re-arms the cached keys, debounced, and the
   * stale snapshot keeps rendering until the fresh one lands — never a flash
   * of empty columns.
   */
  boardFor: (
    kind: string,
  ) => (filter: unknown, groupBy: string) => BoardSnapshot | undefined;
  /**
   * The rail's counters for one kind, or `undefined` when there is no answer
   * yet (not read, or a node that cannot serve them).
   *
   * `undefined` and `{ total: 0 }` are DIFFERENT and both are meaningful: the
   * first draws no number at all, the second draws a real zero. Collapsing
   * them would let an unavailable counter read as "this space is empty".
   */
  countsFor: (kind: string) => { total: number; unseen: number } | undefined;
  /** Re-read the counters now — after a local action that changed what is seen. */
  refreshCounts: () => void;
  detailOf: (id: string) => EntityDetail | undefined;
  /**
   * Re-read one entity's detail NOW, whether or not it is already cached — for
   * a local write whose effect lives on the detail rather than in a counter.
   *
   * The attachment strip is the case that named it: an `attached_to` edge lands
   * on `detail.connections`, nothing about it bumps a counter, and the panel
   * that must show it is by definition the one whose detail is already cached.
   * `pull` cannot serve that (see its docblock) — it would early-return.
   *
   * REQUIRED, not optional. A host that forgets it draws a control that appears
   * to work and changes nothing, which is the defect this replaced; making it
   * required means the typechecker says so at the mount site.
   */
  refetchDetail: (id: string) => void;
  /** Live edge projection for a hydrated entity; unlike detail.connections it advances with events. */
  connectionsOf: (id: string) => import('@tm8/contract').Connections | undefined;
  /** Pool byte-activity, scripted in Phase 1 (§9.2 stub) — NEVER liveness. */
  activity: Readonly<Record<string, boolean>>;
  /**
   * Messages that JUST arrived, sender included, for the session tree's wire
   * pulse. Transient by construction: entries expire on their own, and this is
   * empty in the steady state. Not liveness, and not a substitute for the
   * thread — the durable message is in `messagesByAnchor` either way.
   */
  messagePulses: readonly MessagePulse[];
  /** Server-hydrated graph lens, projected live through entity/edge events. */
  graph: GateGraphData;
  /** Launch resources from the active seam; never presentation fixtures. */
  launch: {
    teammates: readonly LaunchTeammate[];
    projects: readonly LaunchProject[];
    profiles: readonly LaunchProfile[];
    capacity?: LaunchCapacity;
  };
  /** Hydrate a kind the viewer selected after boot. Idempotent. */
  ensureKind: (kind: string) => void;
  /** Switch the active space and hydrate its own menu, channels, and data. */
  selectSpace: (spaceId: SpaceId) => void;
  /** Add and immediately open a Space returned by the onboarding saga. */
  acceptSpace: (space: SpaceSummary) => void;
  /**
   * D44: launch runs through the active seam's command path. Command patches
   * reconcile immediately and the durable event stream remains authoritative.
   */
  /** Spawn and return the authoritative work-session id for immediate focus. */
  spawn: (input: ExecutionSpawnInput) => Promise<EntityId>;
  /** The composer's dispatcher (Surface Audit): seam postMessage, then the
      anchor's thread re-read so the echo is on screen, not implied. */
  postMessage: (input: PostMessageInput) => Promise<void>;
  /** The thread for an entity, hydrated by pull(). Absent = no read ran. */
  messagesOf: (id: string) => readonly MessageView[] | undefined;
  /** Reconcile a command's authoritative detail and every summary patch. */
  reconcileCommand: (result: CommandResult | AttentionRequestMutationResult) => void;
  seam: Seam;
  domain: DomainStoreHandle;
}

/** Kinds the gate screen hydrates up front: the two workspace side panels. */
export interface GateOptions {
  leftKind: string;
  rightKind: string;
  /** Relative same-origin base. Named Servers use the local node's relay. */
  serverBaseUrl?: string;
  /**
   * The viewer's `tm8s_…` pass for the active server, read per request by the
   * transport. Omitted ⇒ requests carry no Authorization header and a
   * loopback node answers as the auto-owner (T-L7).
   */
  getAuthToken?: () => string | null;
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
          ...(options.serverBaseUrl
            ? {
                baseUrl: options.serverBaseUrl,
                wsUrl: `${location.origin.replace(/^http/i, 'ws')}${options.serverBaseUrl}/v2/ws`,
              }
            : {}),
          // The local Server stays default-relative. A named Server uses the
          // same-origin relay above, so browser CORS never becomes transport.
          ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
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
  const [members, setMembers] = useState<readonly ActorSummary[]>([]);
  const [viewerActor, setViewerActor] = useState<ActorSummary | null>(null);
  const [spaceId, setSpaceId] = useState<SpaceId>('' as SpaceId);
  const [menu, setMenu] = useState<ResolvedMenu>(() => resolveMenu(null));
  const [connection, setConnection] = useState<ConnectionState>(() => seam.getConnection());
  const [liveIds, setLiveIds] = useState<readonly string[]>([]);
  // Undefined until the first successful read, and again for a node that
  // cannot serve them — DISTINCT from `{}` (a space that genuinely has no
  // entities). The rail draws no number in the first case and a real zero in
  // the second, so an unavailable counter never masquerades as an empty space.
  const [kindCounts, setKindCounts] = useState<SpaceKindCounts | undefined>(undefined);
  const [executionCapacity, setExecutionCapacity] = useState<LivenessSnapshot['capacity']>();
  const [linkedProjects, setLinkedProjects] = useState<readonly ProjectResource[]>([]);
  const [spaceDefaultProfileId, setSpaceDefaultProfileId] = useState<EntityId | null>(null);
  const [teammateProfileDefaults, setTeammateProfileDefaults] = useState<Readonly<Record<string, EntityId | null>>>({});
  const [graphLoad, setGraphLoad] = useState<{
    phase: 'loading' | 'ready' | 'error';
    error: string | null;
    now: string;
  }>(() => ({ phase: 'loading', error: null, now: new Date().toISOString() }));
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
  const activity = useTerminalActivityMap(terminalActivitySource);
  const messagePulses = useMessagePulses(seam);

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
  const edgeProjection = useSyncExternalStore(
    domain.store.subscribe,
    () => domain.store.getState().edges,
  );
  const messagesByAnchor = useSyncExternalStore(
    domain.store.subscribe,
    () => domain.store.getState().messagesByAnchor,
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

  const loadGraph = useCallback(
    async (space: SpaceId) => {
      setGraphLoad((current) => ({ ...current, phase: 'loading', error: null }));
      try {
        const result = await seam.graph({ spaceId: space, layout: 'graph', limit: 150 });
        const store = domain.store.getState();
        store.ingestSummaries(result.nodes);
        store.ingestEdges(result.edges);
        setGraphLoad({ phase: 'ready', error: null, now: new Date().toISOString() });
      } catch (error: unknown) {
        setGraphLoad({
          phase: 'error',
          error: String((error as { message?: string })?.message ?? error),
          now: new Date().toISOString(),
        });
      }
    },
    [seam, domain],
  );

  /**
   * Hydration is written as ONE idempotent, re-runnable function from day one
   * (§10.2.5): `onResync` means catch-up integrity was lost, and the only
   * honest response is to re-run the reads rather than patch around the gap.
   */
  const hydrate = useCallback(
    async (space: SpaceId) => {
      const [menuRaw, snapshot, projects, settings, identity, , counts] = await Promise.all([
        seam.menu(space).catch((error: unknown) => {
          setMenu(resolveMenu(undefined, error));
          return undefined;
        }),
        // `refresh()` RESOLVES the snapshot; there is no accessor to read one
        // back. Holding the latest is this layer's job by design (A1c), which
        // is why every renderer below takes `liveIds` as a plain array.
        seam.liveness.refresh(space).catch(() => undefined),
        seam.projects(space),
        seam.spaceSettings(space),
        // Display identity is an enhancement to boot, not an availability
        // gate. Membership still drives the people filter when identity is
        // unreadable; only the viewer-specific face stays absent.
        seam.identity().catch(() => null),
        loadGraph(space),
        // SOFT-FAILS to `undefined`, like `menu` above and unlike the reads
        // that gate boot. The rail's numbers are an enhancement: a node that
        // cannot answer this should render a rail with no counts, never a
        // workspace that refuses to open. Absent counters are also why the
        // rail draws nothing rather than `0` on a miss — see `countsFor`.
        // `Promise.resolve().then(...)` rather than a bare call: it converts a
        // SYNCHRONOUS throw into a rejection the `.catch` can absorb. A direct
        // `seam.counts(...)` that threw before returning a promise would take
        // the whole `Promise.all` down and leave the workspace stuck at
        // `ready === false` — the counters failing must never cost the boot.
        Promise.resolve().then(() => seam.counts(space)).catch(() => undefined),
      ]);
      if (menuRaw !== undefined) setMenu(resolveMenu(menuRaw as MenuConfig | null));
      if (snapshot) {
        setLiveIds(snapshot.liveEntityIds);
        setExecutionCapacity(snapshot.capacity);
      }
      setLinkedProjects(projects);
      // Rolling/fixture seams from before membership projection may omit the
      // array. Treat that as unread membership, never as a fabricated actor.
      const memberActors = (settings.members ?? []).map((member) => member.actor);
      const viewerMemberId = identity?.memberships.find((membership) => membership.spaceId === space)?.memberId;
      setMembers(memberActors);
      setViewerActor(memberActors.find((member) => member.id === viewerMemberId) ?? null);
      setSpaceDefaultProfileId(settings.defaultInteractionProfileId);
      if (counts) setKindCounts(counts);

      const load = async (kind: string, limit?: number) => {
        const query = { spaceId: space, kinds: [kind], ...(limit ? { limit } : {}) } as unknown as CollectionQuery;
        const result = await seam.query(query);
        // Same key shape rowsFor reads: an unfiltered read is the '*' key.
        absorb(`${kind}::*`, result.page.items);
        return result.page.items;
      };
      // BOUNDED, not `Promise.all`: these are the collections.query calls that
      // boot fires per kind, and unbounded they arrive at the node together —
      // with the counts/menu/graph reads above already in flight, ONE tab's
      // boot approached the whole pool, and two tabs exceeded it. The rail's
      // counters already come from the one-query `spaces.counts` read above;
      // only the panels' actual rows justify per-kind queries at all.
      const loaded = await mapLimit(
        [...new Set([options.leftKind, options.rightKind, 'team_member', 'interaction_profile'])],
        BOOT_READ_CONCURRENCY,
        async (kind) => {
          // LAUNCH SOURCES ASK FOR THE WHOLE SET, EXPLICITLY. An unbounded
          // collections.query takes the server's DEFAULT_LIMIT of 50, and these
          // two kinds are not a list the viewer pages through — they are the
          // COMPLETE option set behind the teammate and profile pickers. Past
          // 50 teammates the 51st simply stops being offerable, with no error
          // and no reason shown: the picker looks complete and is not. Panel
          // kinds keep the default, because those ARE paged lists.
          const items = await load(kind, LAUNCH_SOURCE_KINDS.has(kind) ? MAX_COLLECTION_LIMIT : undefined);
          return { kind, items };
        },
      );
      const unnamedProfiles = loaded
        .filter((entry) => entry.kind === 'interaction_profile')
        .flatMap((entry) => entry.items)
        .filter((profile) => profile.state.kind === 'interaction_profile' && profile.title.trim().length === 0);
      // Older nodes returned Interaction Profile collection rows with an empty
      // envelope title even though the canonical entity detail already knew
      // the versioned draft name. Resolve only those compatibility rows. A
      // current node returns the name in the summary and pays zero extra reads.
      await mapLimit(unnamedProfiles, BOOT_READ_CONCURRENCY, async (profile) => {
        const detail = await seam.entity(profile.id).catch(() => undefined);
        if (detail) domain.store.getState().ingestDetail(detail);
      });
      /* THE AUTHORITATIVE SET REPLACES THE SEED — including the rows it does
         NOT contain.

         `ingestSummaries` MERGES, so a teammate deleted while this browser was
         closed would be seeded from cache, survive hydrate untouched, and stay
         in the picker for the whole session. Nothing else would ever remove it:
         the server cannot send an `entity.deleted` event for something that was
         deleted before this client connected.

         So the seeded ids hydrate did not return are tombstoned explicitly. The
         launch memo already drops `deletedAt !== null`, so this is the same
         mechanism a live deletion uses rather than a second code path. */
      const launchRows = loaded
        .filter((entry) => CACHED_LAUNCH_KINDS.has(entry.kind))
        .flatMap((entry) => entry.items);
      const returned = new Set(launchRows.map((row) => row.id));
      const orphaned = (seededIds.current.get(space) ?? []).filter((id) => !returned.has(id));
      if (orphaned.length > 0) {
        const store = domain.store.getState();
        const stale = orphaned
          .map((id) => store.entities[id as EntityId])
          .filter((row): row is EntitySummary => row !== undefined && row.deletedAt === null)
          .map((row) => ({ ...row, deletedAt: new Date().toISOString() }));
        if (stale.length > 0) store.ingestSummaries(stale);
      }
      seededIds.current.delete(space);

      // Persisted from the READ, not the store: the cache must only ever hold
      // rows the server actually returned.
      writeLaunchCache(nodeKeyOf(options.serverBaseUrl), space, launchRows);

      const teammateRows = loaded
        .filter((entry) => entry.kind === 'team_member')
        .flatMap((entry) => entry.items);
      // Bounded for the same reason as the kind loads: this is one request PER
      // TEAMMATE, the only boot read whose count scales with the space.
      const defaults = await mapLimit(teammateRows, BOOT_READ_CONCURRENCY, async (teammate) => {
        const page = await seam.connections(teammate.id, { limit: 200 }).catch(() => undefined);
        const edge = page?.items.find((candidate) =>
          candidate.type === 'defaults_to_profile' && candidate.source.id === teammate.id);
        return [teammate.id, edge?.target.id ?? null] as const;
      });
      setTeammateProfileDefaults(Object.fromEntries(defaults));
    },
    [seam, options.leftKind, options.rightKind, options.serverBaseUrl, absorb, loadGraph, domain],
  );

  /**
   * Ids seeded from the browser cache, per space, awaiting hydrate's verdict.
   * A ref because it is bookkeeping BETWEEN two effects, never rendered.
   */
  const seededIds = useRef(new Map<string, string[]>());

  const [bootError, setBootError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);

  // Fetch the viewer's spaces. Opening and hydrating the selected space
  // is a separate effect below so the tab bar is a real switch, not a painted
  // control whose handler discards the id.
  //
  // THE READ RETRIES FOREVER, and the backoff is OVERLOAD-AWARE
  // (`bootRetryDelayMs`): 15s cap while the node is unreachable, 60s cap the
  // moment it answers 503 — because against a saturated pool the retry IS the
  // load, and a loop that treats "drowning" like "absent" never converges
  // (measured: ~50 req/s sustained, self-inflicted). An unreachable node is a
  // NORMAL state (see the bootError note below), and it is also usually a
  // TRANSIENT one — the node restarts, the pool un-wedges, the laptop wakes.
  // A boot that tries once turns every transient into a permanent error card
  // that only a manual reload clears. The error is still surfaced on every
  // failed attempt (`bootError` renders while the retry loop keeps working),
  // so honesty and self-healing are not traded against each other. The HTTP
  // transport bounds each attempt (DEFAULT_REQUEST_TIMEOUT_MS), so this loop
  // can never stack concurrent requests.
  useEffect(() => {
    let cancelled = false;
    let delayHandle: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const list = await seam.spaces();
          if (cancelled) return;
          setAuthRequired(false);
          setSpaces(list);
          const first = list[0];
          if (!first) {
            // ZERO SPACES IS A STATE, NOT A WAIT. This used to `return` and
            // leave the spinner up forever — an empty node looked identical
            // to a hung one. There is nothing to open, so say so and stop.
            setBootError(
              'this node has no spaces yet — the workspace has nothing to open. Create a space, then reload.',
            );
            return;
          }
          setBootError(null);
          // THE SPACE THIS BROWSER LAST HAD OPEN ON THIS NODE WINS.
          //
          // `first.id` alone meant every remount landed on the node's first
          // space — and a server switch REMOUNTS this hook (App.tsx keys
          // GateApp by server id), so a round trip out to a Server and back
          // silently threw your place away. The remembered id is a preference,
          // never an assertion: it is only honoured when the node's own list
          // still contains it, so a deleted or no-longer-visible space falls
          // back to the first exactly as before.
          const remembered = readLastSpace(nodeKeyOf(options.serverBaseUrl));
          const chosen = list.find((space) => space.id === remembered) ?? first;
          setSpaceId(chosen.id);
          return;
        } catch (error: unknown) {
          // AN UNREACHABLE NODE IS A NORMAL STATE, not a crash.
          //
          // `ready` stays false and the failure is HELD rather than swallowed:
          // the shell keeps its loading state and the reason is available,
          // which is the honest rendering of "we could not reach the node" —
          // never an empty workspace that looks like a space with nothing in
          // it. (With the fixture seam this could never happen; found as an
          // unhandled rejection the first time the real flag met a down node.)
          if (cancelled) return;
          // A node that ANSWERED with "unauthenticated" is not unreachable —
          // it is refusing this browser's credential (or its absence). No
          // retry can change that answer; only a new pass can. So the loop
          // parks on the session store and re-reads the moment a sign-in (or
          // sign-out, or another tab's change) lands, instead of hammering a
          // refusal on a timer.
          const unauthenticated =
            error instanceof CollabError && error.code === 'unauthenticated';
          setAuthRequired(unauthenticated);
          setBootError(String((error as { message?: string })?.message ?? error));
          await new Promise<void>((resolve) => {
            if (unauthenticated) {
              unsubscribe = subscribeToSession(() => {
                unsubscribe?.();
                unsubscribe = undefined;
                resolve();
              });
            } else {
              delayHandle = setTimeout(resolve, bootRetryDelayMs(attempt, error));
            }
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (delayHandle !== undefined) clearTimeout(delayHandle);
      unsubscribe?.();
    };
  }, [seam]);

  const openedSpace = useRef<SpaceId | null>(null);
  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    const previous = openedSpace.current;
    if (previous && previous !== spaceId) seam.closeSpace(previous);
    openedSpace.current = spaceId;

    setReady(false);
    setBootError(null);
    setRows({});
    // A space switch or resync invalidates every grouped read with the rows.
    setBoards({});
    pendingBoards.current.clear();
    setMembers([]);
    setViewerActor(null);
    setMenu(resolveMenu(null));
    setLiveIds([]);
    // Back to "unknown", not to `{}`: the previous space's numbers must not
    // survive the switch, and a zero would be a claim about the new space we
    // have not read yet.
    setKindCounts(undefined);
    setLinkedProjects([]);
    setTeammateProfileDefaults({});

    // SEED THE OPTION SETS BEFORE THE FIRST READ IS EVEN SENT.
    //
    // Deliberately here, in the space-open effect, and not once at mount: the
    // cache is per space, so switching spaces has to re-seed from the NEW
    // space's set rather than leave the previous space's teammates on offer.
    //
    // This only writes `entities`. It writes no `rows` entry, so it cannot put
    // a row in any LIST — the seed reaches exactly the consumers that scan the
    // store for an option set, which is the launch pickers. `hydrate` below
    // replaces all of it with the server's answer moments later; until then a
    // populated picker beats an empty one, and a stale option refuses at spawn
    // with the node's own reason rather than silently doing the wrong thing.
    const seeded = readLaunchCache(nodeKeyOf(options.serverBaseUrl), spaceId);
    if (seeded) {
      // Remembered so hydrate can tombstone whichever of them the server no
      // longer returns. Without this the seed would be unretractable.
      seededIds.current.set(spaceId, seeded.map((row) => row.id));
      domain.store.getState().ingestSummaries(seeded);
    }

    // Same retry law as the spaces read above, including the overload-aware
    // backoff — hydration is the HEAVY read set (a dozen-plus requests), so a
    // fast retry of it against a 503ing node is the storm's worst case:
    // hydration failure is surfaced immediately AND retried with capped
    // backoff, because "the node blinked while I switched spaces" must not
    // strand the workspace on an error card (or, before the transport timeout
    // existed, on a spinner) until reload.
    let delayHandle: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          await seam.openSpace(spaceId);
          await hydrate(spaceId);
          if (!cancelled) {
            setBootError(null);
            setReady(true);
          }
          return;
        } catch (error: unknown) {
          if (cancelled) return;
          setBootError(String((error as { message?: string })?.message ?? error));
          await new Promise<void>((resolve) => {
            delayHandle = setTimeout(resolve, bootRetryDelayMs(attempt, error));
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (delayHandle !== undefined) clearTimeout(delayHandle);
    };
  }, [seam, spaceId, hydrate]);

  const selectSpace = useCallback((next: SpaceId) => {
    if (next === spaceId || !spaces.some((space) => space.id === next)) return;
    setSpaceId(next);
  }, [spaceId, spaces]);

  // The one place the choice is recorded, so boot's pick and the tab bar's pick
  // are remembered by the same rule and neither can drift from the other.
  useEffect(() => {
    if (!spaceId) return;
    writeLastSpace(nodeKeyOf(options.serverBaseUrl), spaceId);
  }, [spaceId, options.serverBaseUrl]);

  const acceptSpace = useCallback((space: SpaceSummary) => {
    setSpaces((current) => current.some((candidate) => candidate.id === space.id)
      ? current.map((candidate) => candidate.id === space.id ? space : candidate)
      : [...current, space]);
    setBootError(null);
    setSpaceId(space.id);
  }, []);

  // Connection honesty, rendered once in the shell and selected everywhere
  // (§10.2.4). `polling` is a degraded-but-advancing state, not an outage.
  useEffect(() => seam.onConnection(setConnection), [seam]);

  /**
   * Keep the real seam's liveness evidence fresh for the lifetime of this data
   * shell. Liveness is consumed globally (session rows, the live bar, home,
   * graph and terminal gating), so the shell itself is the correct visibility
   * boundary: tying this only to LiveTerminal would let its 90s snapshot expire,
   * classify the selected session as `unknown`, and unmount the very terminal
   * that would otherwise have kept the cadence alive.
   *
   * `RealControls` is deliberately an implementation extension rather than a
   * widening of the transport-neutral Seam. Fixture/injected seams simply have
   * no control and need no interval. The cleanup is StrictMode-safe because the
   * liveness manager's setter is idempotent.
   */
  useEffect(() => {
    const controls = (seam as Seam & { realControls?: RealControls }).realControls;
    if (!controls) return undefined;
    controls.setSessionSurfaceVisible(true);
    return () => controls.setSessionSurfaceVisible(false);
  }, [seam]);

  // Each cadence read publishes the fresh live set through this subscription.
  useEffect(
    () => seam.liveness.onChange((snapshot) => {
      setLiveIds(snapshot.liveEntityIds);
      setExecutionCapacity(snapshot.capacity);
    }),
    [seam],
  );

  /**
   * Counters follow the DURABLE STREAM, which is what makes them live: any
   * entity event can change a total (a create, a delete) or flip a row back to
   * unseen (an update to something you had already read).
   *
   * Debounced with a TRAILING timer rather than issuing one read per event. A
   * burst is the normal case here — a spawn, a bulk import, or an agent
   * writing a run of messages — and one count query per event would turn a
   * busy space into a self-inflicted request flood for a number that is only
   * ever read at a glance.
   */
  useEffect(() => {
    if (!spaceId) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = seam.onEvent(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void Promise.resolve()
          .then(() => seam.counts(spaceId))
          .then(setKindCounts)
          .catch(() => undefined);
      }, COUNTS_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [seam, spaceId]);

  /**
   * KEEP THE CACHE CURRENT FROM THE DURABLE STREAM.
   *
   * Boot writes the authoritative set; this keeps it true for the rest of the
   * session, so a teammate created, renamed, re-modelled or deleted while the
   * tab is open is already correct in the picker on the NEXT load rather than
   * only after that load's read returns.
   *
   * Safe to dump from the store precisely BECAUSE hydrate tombstones orphaned
   * seeds above: every live launch-kind row in the store is one the server
   * either just returned or just sent an event for. Without that pruning this
   * would re-persist stale rows forever.
   *
   * Debounced and trailing, for the same reason the counters read is: a spawn
   * or a bulk import is a BURST, and one JSON serialisation of the whole option
   * set per event would be a self-inflicted main-thread cost for a value only
   * read at the next boot.
   */
  useEffect(() => {
    if (!ready || !spaceId) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      timer = undefined;
      const rows = Object.values(domain.store.getState().entities).filter(
        (row) => row.spaceId === spaceId && row.deletedAt === null && CACHED_LAUNCH_KINDS.has(row.state.kind),
      );
      writeLaunchCache(nodeKeyOf(options.serverBaseUrl), spaceId, rows);
    };
    const unsubscribe = domain.store.subscribe(() => {
      if (timer) return;
      timer = setTimeout(persist, LAUNCH_CACHE_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [ready, spaceId, domain, options.serverBaseUrl]);

  // Catch-up integrity lost ⇒ re-run hydration. Idempotent by construction.
  useEffect(
    () =>
      seam.onResync((space) => {
        if (space !== spaceId) return;
        // Detail reads are re-armed with everything else: a resync means the
        // catch-up gap could have swallowed anything, including whatever made
        // a detail read fail.
        pulledDetails.current.clear();
        pulledMessages.current.clear();
        // The retry budget is part of "re-run the reads": an entity whose
        // attempts were spent against a node that was failing must get a fresh
        // budget once catch-up integrity is re-established, or the resync would
        // re-arm a read the backoff then refuses.
        readFailures.current.clear();
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
  /** Detail and Discussion hydrate independently. A command can populate the
      detail cache before the panel ever reads its messages, so one shared id
      guard would make that thread permanently look empty. */
  const pulledDetails = useRef(new Set<string>());
  /** Last message-count generation requested per anchor. Unlike detail, a
      thread can become stale while its panel remains open. Recording the
      observed count permits one new read when the server counter advances,
      without turning a failed read into a render-time request loop. */
  const pulledMessages = useRef(new Map<string, number>());
  /**
   * Failed reads, per id, so a read that FAILED can be retried without becoming
   * a request loop. Both halves of that sentence are load-bearing:
   *
   * - Never retrying strands the panel. A claim is taken BEFORE the await, so a
   *   read that rejects leaves the id claimed with nothing cached, `needsDetail`
   *   permanently false, and `loading={!detail}` permanently true. The owner's
   *   session recorded 13 x 503 and 23 x 499 against 452 x 200: the node was
   *   healthy for almost every read, and one failure per entity was enough.
   * - Retrying without a bound is the loop the guard was written to prevent —
   *   `renderPanel` calls `pull` FROM RENDER whenever the detail is missing, so
   *   an entity that can never be read would be re-requested every render.
   *
   * So a failure is remembered with an attempt count and an earliest-next-try
   * stamp. Bounded attempts, spaced by backoff, then it stops for good.
   */
  const readFailures = useRef(new Map<string, ReadFailure>());
  /**
   * The latest `rows`, for callbacks that only GUARD on it. `ensureKind`
   * used to take `rows` as a dependency — but calling it WRITES `rows` (via
   * `absorb`/`setRows`), so its identity churned on its own writes, and every
   * effect and memo holding it re-fired per write. On a healthy node the
   * per-key guards made that mere churn; against a node that was 503ing, the
   * churn re-entered effects exactly when the caches were empty and multiplied
   * the retry storm. A read-through ref breaks the cycle: the guard still sees
   * the CURRENT rows at call time, and the callback's identity depends only on
   * the space and the seam.
   */
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const ensureKind = useCallback(
    (kind: string) => {
      if (!spaceId || rowsRef.current[`${kind}::*`] || inFlight.current.has(kind)) return;
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
    [seam, spaceId, absorb],
  );

  useEffect(() => {
    if (!ready) return;
    ensureKind(options.leftKind);
    ensureKind(options.rightKind);
  }, [ready, options.leftKind, options.rightKind, ensureKind]);

  const spawn = useCallback(
    async (input: ExecutionSpawnInput) => {
      const result = await seam.commands.spawn(input);
      domain.store.getState().ingestSummaries(result.patches);
      if (result.entity) domain.store.getState().ingestDetail(result.entity);
      domain.store.getState().reconcile(input.clientMutationId);

      const sessionId = result.entity?.id
        ?? result.patches.find((patch) => patch.state.kind === 'work_session')?.id;
      if (!sessionId) {
        throw new Error('execution.spawn returned no work-session entity');
      }

      // The command result opens the caller's terminal immediately. The
      // durable entity.upsert event independently converges other clients;
      // neither path needs a browser refresh or a post-command full hydrate.
      return sessionId;
    },
    [seam, domain],
  );

  const launch = useMemo<GateData['launch']>(() => {
    const summaries = Object.values(entities).filter((row) => row.spaceId === spaceId && row.deletedAt === null);
    const teammates: LaunchTeammate[] = summaries.flatMap((row) => {
      if (row.state.kind !== 'team_member') return [];
      const supportedModel = launchModel(row.state.model);
      if (!supportedModel || supportedModel.agentTool !== row.state.agentTool) return [];
      const name = row.title || row.id;
      return [{
        id: row.id,
        name,
        initial: name.slice(0, 1).toUpperCase(),
        model: row.state.model ?? '',
        agentTool: row.state.agentTool ?? '',
        owner: row.state.owner.displayName,
        liveSessions: null,
        ...(teammateProfileDefaults[row.id]
          ? { defaultProfileId: teammateProfileDefaults[row.id] ?? undefined }
          : {}),
      }];
    });
    const profiles: LaunchProfile[] = summaries.flatMap((row) => {
      if (row.state.kind !== 'interaction_profile') return [];
      return [{
        id: row.id,
        name: row.title || row.id,
        version: row.state.activeVersion ?? row.state.currentDraftVersion,
        status: row.state.status,
        isSpaceDefault: row.id === spaceDefaultProfileId,
        /* The template facts stay constant — one static template ships, and
           profiles are validated against it before launch. The SURFACE does
           not: it is the profile's own choice now, so the picker reads it
           from the projection instead of asserting Chat for everyone. A draft
           with no opinion still falls back to the template's Chat, which is
           what it will actually do once pinned. */
        ...CORE_CHAT_LAUNCH_PRESENTATION,
        initialContentSurface:
          row.state.initialContentSurface ?? CORE_CHAT_LAUNCH_PRESENTATION.initialContentSurface,
      }];
    });
    const projects: LaunchProject[] = linkedProjects.map((project, index) => ({
      id: project.id,
      name: project.name,
      trusted: project.trust === 'trusted',
      detail: project.trust === 'trusted'
        ? `trusted · ${project.workingDir}`
        : '',
      ...(project.trust === 'untrusted'
        ? { reason: "untrusted — can't host sessions · trust it in Node settings" }
        : {}),
      selectedByDefault: index === 0 && project.trust === 'trusted',
    }));
    const capacity = executionCapacity
      ? {
          slotsFree: Math.max(0, executionCapacity.total - executionCapacity.used),
          slotsTotal: executionCapacity.total,
        }
      : undefined;
    return { teammates, projects, profiles, ...(capacity ? { capacity } : {}) };
  }, [entities, spaceId, linkedProjects, executionCapacity, spaceDefaultProfileId, teammateProfileDefaults]);

  /* Surface Audit 2026-07-29: the composer rendered ENABLED and wired to
     nothing — inviting an action it could not perform, the worst honesty
     class on the board. Same passthrough shape as spawn: the seam command,
     then the anchor's own thread re-read (postAndRefresh below) so the echo
     is on screen.

     THIS USED TO RE-RUN hydrate() — the FULL boot read set (menu, liveness,
     projects, settings, graph, four kind queries, one connections read per
     teammate) after EVERY message sent. Against a pool of 8 that is a
     self-inflicted burst of a dozen-plus transactions per keystrokeful of
     chat, and it is redundant: the durable event stream (message.created,
     counter.changed) converges every summary a post can touch, and the
     thread re-read shows the echo. The command result plus the stream IS the
     convergence path — the same rule spawn() already follows. */
  const postMessage = useCallback(
    async (input: PostMessageInput) => {
      await seam.commands.postMessage(input);
    },
    [seam],
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

  // -- Board reads (A2) -------------------------------------------------------
  //
  // Same key-miss-then-drain shape as `rowsFor` above, for the same reason:
  // requesting from inside render must never dispatch. A separate cache
  // because the answer is a different SHAPE — the server's groups, not a row
  // array — and because its refresh rule differs: group membership is
  // server-computed, so a state change must re-run the grouped read rather
  // than re-project rows locally (the client never groups, L3).
  const [boards, setBoards] = useState<Readonly<Record<string, BoardSnapshot>>>({});
  const pendingBoards = useRef(new Set<string>());
  const [boardTick, setBoardTick] = useState(0);
  const boardKeys = useRef<readonly string[]>([]);
  boardKeys.current = Object.keys(boards);

  const boardFor = useCallback(
    (kind: string) =>
      (filter: unknown, groupBy: string): BoardSnapshot | undefined => {
        const key = `${kind}::${groupBy}::${filter === undefined ? '*' : stableKey(filter)}`;
        const hit = boards[key];
        if (hit === undefined && !pendingBoards.current.has(key)) {
          pendingBoards.current.add(key);
          queueMicrotask(() => setBoardTick((n) => n + 1));
        }
        return hit;
      },
    [boards],
  );

  useEffect(() => {
    if (!ready || !spaceId || pendingBoards.current.size === 0) return;
    const keys = [...pendingBoards.current];
    pendingBoards.current.clear();
    for (const key of keys) {
      const [kind, groupBy, filterPart] = key.split('::');
      const query = {
        spaceId,
        kinds: [kind],
        groupBy,
        ...(filterPart && filterPart !== '*' ? { filters: JSON.parse(filterPart) } : {}),
      } as unknown as CollectionQuery;
      void seam
        .query(query)
        .then((result) => {
          setBoards((current) => ({
            ...current,
            [key]: {
              groups: result.groups ?? [],
              nextCursor: result.page.nextCursor,
              // The resolved query names the limit it applied; the honesty
              // banner needs the number, not a guess.
              limit: result.query.limit ?? result.page.items.length,
            },
          }));
        })
        .catch((error: unknown) => {
          setBoards((current) => ({
            ...current,
            [key]: {
              groups: [],
              nextCursor: null,
              limit: 0,
              error: String((error as { message?: string })?.message ?? error),
              retry: () => {
                setBoards(({ [key]: _gone, ...rest }) => rest);
                pendingBoards.current.add(key);
                setBoardTick((n) => n + 1);
              },
            },
          }));
        });
    }
  }, [ready, spaceId, seam, boardTick]);

  // Keep the board current from the durable stream, debounced like the
  // counters read: any event re-arms every cached key. The STALE snapshot
  // keeps rendering until the fresh one lands — a refetch must never flash
  // skeletons over a board someone is dragging on.
  useEffect(() => {
    if (!spaceId) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = seam.onEvent(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (boardKeys.current.length === 0) return;
        for (const key of boardKeys.current) pendingBoards.current.add(key);
        setBoardTick((n) => n + 1);
      }, COUNTS_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [seam, spaceId]);

  const detailOf = useCallback((id: string) => details[id as EntityId], [details]);
  const connectionsOf = useCallback(
    (id: string) => selectConnectionsOf(id as EntityId)(domain.store.getState()),
    // edgeProjection/details are subscribed snapshots: their identity changes
    // re-create this callback and therefore re-render every consumer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domain, edgeProjection, details],
  );

  const reconcileCommand = useCallback(
    (result: CommandResult | AttentionRequestMutationResult) => {
      const store = domain.store.getState();
      if ('affectedCount' in result) {
        store.ingestSummaries([result.entity]);
        return;
      }
      if (result.patches.length > 0) store.ingestSummaries(result.patches);
      if (result.entity) store.ingestDetail(result.entity);
    },
    [domain],
  );

  /**
   * FILL a panel's cache — never invalidate it. Safe to call from render, and
   * `renderPanel` does exactly that, which is why the early return below is
   * load-bearing rather than an optimisation.
   *
   * THE COROLLARY, stated because it was missed once: `pull` CANNOT refresh an
   * open panel. Its detail is cached (that is why it renders) and an edge
   * change bumps no message counter, so both halves read fresh and this
   * returns without a request. A local write that must be re-read goes through
   * `refetchDetail`.
   */
  const pull = useCallback(
    async (id: string) => {
      const state = domain.store.getState();
      const needsDetail = state.details[id as EntityId] === undefined
        && !pulledDetails.current.has(id);
      const cachedMessages = state.messagesByAnchor[id as EntityId];
      const messageCount = state.entities[id as EntityId]?.counters.messages
        ?? state.details[id as EntityId]?.counters.messages
        ?? cachedMessages?.length
        ?? -1;
      const messagesStale = cachedMessages === undefined
        || representedThreadMessageCount(cachedMessages) < messageCount;
      const needsMessages = messagesStale && pulledMessages.current.get(id) !== messageCount;
      if (!needsDetail && !needsMessages) return;
      // Each half carries its OWN budget. Detail and thread already hydrate
      // independently, and a 404 on the detail must not also silence this
      // anchor's thread for the rest of the page — they are different reads
      // about different things and they fail for different reasons.
      const readDetail = needsDetail && !readBlocked(readFailures.current, readKey('d', id));
      const readMessages = needsMessages && !readBlocked(readFailures.current, readKey('m', id));
      if (!readDetail && !readMessages) return;
      if (readDetail) pulledDetails.current.add(id);
      if (readMessages) pulledMessages.current.set(id, messageCount);
      // Each rejection is CAPTURED next to the read that produced it, not
      // merged: "the node is drowning" and "there is no such entity" are both
      // failures, they must not be retried the same way, and one half's answer
      // must not be attributed to the other. Downstream still reads `undefined`.
      let detailError: unknown;
      let threadError: unknown;
      const [detail, thread] = await Promise.all([
        readDetail
          ? seam.entity(id as never).catch((error: unknown) => { detailError = error; return undefined; })
          : Promise.resolve(undefined),
        // The thread rides the same pull: a composer that posts into a tab
        // that never READS is only half a fix (Surface Audit). A read error
        // leaves the id absent — the tab renders its designed empty state
        // rather than a fabricated zero.
        readMessages
          ? seam.messages(id as never).catch((error: unknown) => { threadError = error; return undefined; })
          : Promise.resolve(undefined),
      ]);
      /* WHAT FAILED, AND WHETHER IT MAY BE ASKED AGAIN.
         A claim is taken before the await so concurrent renders issue ONE
         request. If the read then rejects, the claim is RELEASED — otherwise
         the id is remembered as read while nothing was cached, which is
         precisely what left the panel spinning — and the failure is recorded so
         the release is bounded by attempts and spaced by backoff. */
      const detailFailed = readDetail && detail === undefined;
      const threadFailed = readMessages && thread === undefined;
      if (detailFailed) recordReadFailure(readFailures.current, readKey('d', id), detailError);
      if (threadFailed) recordReadFailure(readFailures.current, readKey('m', id), threadError);
      if (detailFailed) pulledDetails.current.delete(id);
      if (threadFailed) pulledMessages.current.delete(id);
      // A half that ANSWERED clears its own record — a failure an hour from now
      // gets a full budget rather than inheriting a spent one — and is also
      // evidence about the NODE, not just this id: it just served a read, so
      // every id whose budget was spent against a node that was failing is
      // given another chance. Terminal records are left alone; a 404 does not
      // become readable because some other entity did.
      if (readDetail && !detailFailed) readFailures.current.delete(readKey('d', id));
      if (readMessages && !threadFailed) readFailures.current.delete(readKey('m', id));
      if ((readDetail && !detailFailed) || (readMessages && !threadFailed)) {
        forgiveExhaustedReads(readFailures.current);
      }
      /* THE DETAIL GOES INTO THE STORE, not beside it. `entity.upsert` then
         overlays the fresher envelope onto it (reducers.mergeSummary keeps the
         heavy sections), so an open panel shows a title someone else changed
         without anyone re-reading — the same loop the lists get, for free.
         The re-entrancy guard moved to a ref because the store's `details` is
         no longer this hook's state: guarding on it would re-arm the read
         every time an event touched the entity. */
      /* A FAILED READ IS RE-ARMED, BUT ONLY A BOUNDED NUMBER OF TIMES (see
         `readFailures`). The older rule here — never re-arm — was written
         against the right hazard and picked the wrong side of it: `renderPanel`
         calls `pull` FROM RENDER whenever the detail is missing, so clearing
         the guard unconditionally on failure IS an unbounded request loop. But
         never clearing it means one 503 strands that entity's panel for the
         life of the page, which is the defect this replaced. The bound is what
         lets both be false at once. `onResync` still clears the claims, the
         same "catch-up integrity was lost, re-run the reads" rule the rest of
         this hook obeys. */
      if (detail) domain.store.getState().ingestDetail(detail);
      if (thread) domain.store.getState().ingestMessages(id as EntityId, [...thread.items]);
    },
    [seam, domain],
  );

  /**
   * RE-READ ONE ANCHOR'S DETAIL, UNCONDITIONALLY — the invalidating half that
   * `pull` deliberately is not.
   *
   * WHY IT CANNOT BE `pull`. `pull` is a cache-FILL primitive: its `needsDetail`
   * is `details[id] === undefined && !pulledDetails.has(id)`, and it early-returns
   * when neither half is stale. AN OPEN PANEL ALWAYS HAS ITS DETAIL CACHED —
   * that is why it renders at all — so `pull(id)` on an open panel is a no-op by
   * construction. That early return is load-bearing (`renderPanel` calls `pull`
   * FROM RENDER, so widening its staleness rule is a request loop against the
   * node), which is why the invalidating path is a SECOND verb rather than a
   * relaxed first one.
   *
   * WHAT MAKES IT SAFE TO BE UNCONDITIONAL: this is only ever called from an
   * EVENT HANDLER for a write that already landed — an attachment uploaded, a
   * link cut. One completed mutation, one read. It is never called from render,
   * so there is no loop to bound and no budget to spend.
   *
   * NOT COALESCED, deliberately. Two uploads landing 200ms apart are two
   * different facts, and handing the second one the first one's in-flight
   * promise would answer it with a read that predates its own edge — the exact
   * class of staleness this function exists to end.
   *
   * DETAIL ONLY. An attachment edge does not touch the thread, and re-reading
   * messages here would spend a round-trip on data that did not change.
   */
  const refetchDetail = useCallback(
    async (id: string) => {
      const detail = await seam.entity(id as never).catch(() => undefined);
      if (!detail) return;
      // The id is now genuinely cached, so `pull` may keep early-returning for
      // it, and a read that ANSWERED clears its own failure record — the same
      // rule `pull` follows for the same reason.
      pulledDetails.current.add(id);
      readFailures.current.delete(readKey('d', id));
      domain.store.getState().ingestDetail(detail);
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
      if (thread) domain.store.getState().ingestMessages(anchor, [...thread.items]);
    },
    [postMessage, seam, domain],
  );

  const graphNodes = useMemo(
    () =>
      graphLoad.phase === 'error'
        ? EMPTY_ROWS
        : Object.values(entities).filter((entity) => entity.spaceId === spaceId),
    [graphLoad.phase, entities, spaceId],
  );
  const graphEdges = useMemo(() => {
    if (graphLoad.phase === 'error') return [];
    const nodeIds = new Set(graphNodes.map((node) => node.id));
    return Object.values(edgeProjection).filter(
      (edge) => nodeIds.has(edge.source.id) && nodeIds.has(edge.target.id),
    );
  }, [graphLoad.phase, graphNodes, edgeProjection]);
  const refreshGraph = useCallback(() => {
    if (spaceId) void loadGraph(spaceId);
  }, [spaceId, loadGraph]);
  const graph = useMemo<GateGraphData>(
    () => ({
      nodes: graphNodes,
      edges: graphEdges,
      loading: graphLoad.phase === 'loading',
      error: graphLoad.error,
      now: graphLoad.now,
      refresh: refreshGraph,
    }),
    [graphNodes, graphEdges, graphLoad, refreshGraph],
  );

  // Exposed through the returned object so views can request a panel's detail
  const countsFor = useCallback(
    (kind: string) => kindCounts?.[kind as keyof SpaceKindCounts],
    [kindCounts],
  );

  const refreshCounts = useCallback(() => {
    if (!spaceId) return;
    void Promise.resolve()
      .then(() => seam.counts(spaceId))
      .then(setKindCounts)
      .catch(() => undefined);
  }, [seam, spaceId]);

  // without reaching for the seam themselves.
  const data = useMemo<GateData & { pull: (id: string) => void }>(
    () => ({
      ready,
      spaceId,
      spaces,
      members,
      viewerActor,
      menu,
      connection,
      bootError,
      authRequired,
      liveIds,
      livenessOf,
      rowsFor,
      boardFor,
      countsFor,
      refreshCounts,
      detailOf,
      refetchDetail: (id: string) => void refetchDetail(id),
      connectionsOf,
      activity,
      messagePulses,
      graph,
      launch,
      ensureKind,
      selectSpace,
      acceptSpace,
      spawn,
      postMessage: postAndRefresh,
      messagesOf: (id: string) => messagesByAnchor[id as EntityId],
      reconcileCommand,
      seam,
      domain,
      pull: (id: string) => void pull(id),
    }),
    [ready, spaceId, spaces, members, viewerActor, menu, connection, bootError, authRequired, liveIds, livenessOf, rowsFor, boardFor, countsFor, refreshCounts, detailOf, refetchDetail, connectionsOf, activity, messagePulses, graph, launch, ensureKind, selectSpace, acceptSpace, spawn, postAndRefresh, messagesByAnchor, reconcileCommand, seam, domain, pull],
  );

  return data;
}
