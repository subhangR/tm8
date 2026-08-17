/**
 * The connection state machine (LLD §6 — the R2 core of this lane).
 *
 * It owns exactly one thing the rest of the data layer must never duplicate:
 * **the per-space cursor**, and the single rule that makes the seam's ordering
 * guarantee true —
 *
 *     if (event.seq <= lastApplied[spaceId]) drop; else advance and dispatch
 *
 * That one line is the whole dedupe and ordering discipline. It is why the seam
 * can promise "strictly increasing seq per space, no duplicates" and why no
 * consumer above it needs a `seenEventIds` set. Gaps are contract-legal (seq is
 * authoritative, not dense), so the cursor is a HIGH-WATER MARK, never a count.
 *
 * The four honesty states and how they are reached (LLD §6, T4):
 *
 *   connecting → the first socket has neither opened nor failed yet.
 *   live       → socket open, spaces subscribed AND resumed, events flowing.
 *   polling    → socket down, but the node still answers `events.poll`, so data
 *                keeps advancing on the SAME seq spine, just slower.
 *   offline    → the socket is down and HTTP is not reaching the node either.
 *
 * `polling` versus `offline` is decided by *transport* evidence, never by
 * request outcomes: a `403` from a poll proves the node is reachable and must
 * not read as offline. `noteTransport(false)` is emitted only when a request
 * never reached the node at all.
 *
 * THREE RULES THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 * - **subscribe is ALWAYS followed by resume.** `subscribe` seeds live delivery
 *   at the server's high-water mark, but if that mark cannot be established the
 *   subscription is left deliberately UNSEEDED and the client CANNOT TELL which
 *   happened (LLD §6 fact 2). `resume` is the only seed this client owns. The
 *   real seam calls `prepareSpace` first, scanning retained cursors without
 *   dispatch, so a first open resumes at H rather than replaying history into
 *   the UI. Direct/unprepared consumers retain the safe `since: 0` fallback.
 * - **one resume suffices.** The server pump is a per-connection log reader
 *   (1s tick, 200/batch) that walks forward from the seed under the caller's
 *   claims, so there is no gap between replay end and live. The accelerate loop
 *   below is PURE THROUGHPUT — re-resuming from the advancing cursor to beat the
 *   pump's ~200/s on a large first-open. The pump remains the correctness
 *   backstop; if the accelerate loop did nothing at all, the client would still
 *   converge. That is the property that makes it safe to run.
 * - **the poll fallback feeds the same dispatch path.** Not a parallel pipeline
 *   with its own dedupe: literally the same function, the same cursor map. WS
 *   and poll agree on one seq spine by construction rather than by test.
 *
 * Everything time-shaped is injectable — timers, clock, jitter — so the tests
 * in this directory drive real transitions with zero waiting and zero network.
 */
import { CollabError, type DurableWorkspaceEvent, type SpaceId } from '@tm8/contract';
import type { ConnectionState, Unsubscribe } from '../seam';
import type { ChatTurnFrame } from '../../chat-home/types';
import type { DurableEventPage } from './ops';
import { openSocket, type SocketHandle, type WebSocketFactory } from './socket';

/** Injectable timers. The handle is opaque so a fake may return anything. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ConnectionConfig {
  /** Reconnect backoff floor and ceiling (LLD §6: 0.5s → 8s cap, jitter). */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** `events.poll` cadence while the socket is down (LLD §6: 1.5s, primed immediately). */
  pollIntervalMs: number;
  /** How often the accelerate loop re-resumes from the advancing cursor. */
  accelerateIntervalMs: number;
  /**
   * Disconnect gap past which hydration is re-run (LLD §6). Event replay stays
   * honest for the 7-day retention, but re-establishing read-model freshness is
   * cheaper than replaying through a long gap.
   */
  resyncGapMs: number;
  /** Server clamps to 500. */
  pollLimit: number;
  /**
   * Inbound silence past which the half-open probe runs (see the idle
   * watchdog). Quiet is normal — this is deliberately generous; the probe,
   * not the silence, decides whether the socket is dead.
   */
  idleProbeAfterMs: number;
  /** How often the watchdog looks at the silence clock while the socket is open. */
  idleCheckIntervalMs: number;
  /** Pages scanned before surfacing progress and retrying from a checkpoint. */
  bootstrapPageBudget: number;
  /**
   * Floor between two LIFECYCLE-forced reconnects (foreground / `online`).
   *
   * The fast path deliberately discards the backoff ladder, because the
   * failures that built it were measured against a network the device no
   * longer has. That is safe exactly once per resume — and a phone can emit
   * `visibilitychange` many times a second (notification shade, app switcher,
   * a passing share sheet). Without a floor, a device flapping visibility
   * against a node that is refusing connections would reset the ladder on
   * every flap and become the hot loop the jitter rule exists to prevent.
   * Inside the floor the ORDINARY backoff still runs, so a resume is never
   * dropped, only de-duplicated.
   */
  resumeMinIntervalMs: number;
}

export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  backoffBaseMs: 500,
  backoffMaxMs: 8_000,
  pollIntervalMs: 1_500,
  accelerateIntervalMs: 400,
  resyncGapMs: 10 * 60 * 1_000,
  // Use the contract's maximum page size. Bootstrap pages are discarded
  // before they can touch state, so larger pages reduce first-open round trips
  // without increasing React work.
  pollLimit: 500,
  idleProbeAfterMs: 90_000,
  idleCheckIntervalMs: 45_000,
  bootstrapPageBudget: 256,
  resumeMinIntervalMs: 1_000,
};

/**
 * Where "the app came back" comes from. Injectable for the same reason the
 * timers are: the tests in this directory drive real transitions with no DOM
 * and no waiting.
 *
 * Subscribes to `onResume` and returns an unsubscribe.
 */
export type LifecycleSource = (onResume: (reason: string) => void) => Unsubscribe;

/**
 * The browser's two "you are back" signals, and only those two.
 *
 * - `visibilitychange` → visible. NOT the hide edge: backgrounding is not news
 *   this state machine can act on, and reacting to it would close a socket the
 *   OS may well leave working.
 * - `online`. `navigator.onLine` is famously optimistic about whether packets
 *   actually flow, which is why this only PROMPTS an attempt — the socket's own
 *   outcome still decides the phase, exactly as it does on every other path.
 *
 * Returns a no-op in a non-DOM host rather than throwing, so the manager stays
 * usable from Node.
 */
export function browserLifecycle(): LifecycleSource {
  return (onResume) => {
    // `typeof` guards rather than truthiness: referencing an UNDECLARED global
    // throws a ReferenceError, so these can never be read directly in Node.
    const doc = typeof document === 'undefined' ? undefined : document;
    const win = typeof window === 'undefined' ? undefined : window;
    if (doc === undefined && win === undefined) return () => {};
    const onVisible = (): void => {
      if (doc?.visibilityState === 'visible') onResume('visible');
    };
    const onOnline = (): void => onResume('online');
    doc?.addEventListener('visibilitychange', onVisible);
    win?.addEventListener('online', onOnline);
    return () => {
      doc?.removeEventListener('visibilitychange', onVisible);
      win?.removeEventListener('online', onOnline);
    };
  };
}

export interface ConnectionDeps {
  /** Absolute ws:// or wss:// URL. Never derived silently — see `seam-real.ts`. */
  wsUrl: string;
  webSocketFactory: WebSocketFactory;
  /** `events.poll` for one space from a seq. Supplied by `ops.ts`. */
  poll(spaceId: SpaceId, since: number, limit?: number): Promise<DurableEventPage>;
  timers?: Timers;
  /** Epoch milliseconds. */
  now?: () => number;
  /** Jitter source in [0,1). */
  random?: () => number;
  config?: Partial<ConnectionConfig>;
  /**
   * "The app came back to the foreground / the network returned." Defaults to
   * the real browser events; pass `() => () => {}` to opt out entirely.
   */
  lifecycle?: LifecycleSource;
  /**
   * Non-fatal transport noise: a malformed frame, a listener that threw, a poll
   * that failed. Reported rather than swallowed — a silent drop here looks
   * exactly like an idle server.
   */
  onError?: (error: unknown, context: string) => void;
  /** Monotonic cursor observation, used by the debounced browser cache. */
  onCursor?: (spaceId: SpaceId, cursor: number) => void;
}

export interface ConnectionManager {
  /**
   * Advance to the retained-log tail without dispatching payloads. This is the
   * frontend-only snapshot barrier: historical rows pay network cost, but
   * never enter Zustand or React.
   */
  prepareSpace(spaceId: SpaceId, since?: number): Promise<number>;
  openSpace(spaceId: SpaceId): void;
  closeSpace(spaceId: SpaceId): void;
  onEvent(cb: (e: DurableWorkspaceEvent) => void): Unsubscribe;
  onChatTurn(cb: (frame: ChatTurnFrame) => void): Unsubscribe;
  onConnection(cb: (s: ConnectionState) => void): Unsubscribe;
  getConnection(): ConnectionState;
  onResync(cb: (spaceId: SpaceId) => void): Unsubscribe;
  /**
   * A `control.refused` naming this space. The seam has no error channel for an
   * asynchronous refusal (it is a locked, dual-consensus file), so the real
   * implementation surfaces it here and `createRealSeam` forwards it to an
   * opt-in callback. Never silent: LLD §6 — "a refused space must not look
   * like a quiet one".
   */
  onSpaceRefused(cb: (spaceId: SpaceId, error: CollabError) => void): Unsubscribe;
  /** Fires each time the socket reaches `live` after having been down (liveness cadence, LLD §9). */
  onReconnect(cb: () => void): Unsubscribe;
  /** Transport reachability from the HTTP client. See the header note on polling vs offline. */
  noteTransport(reachable: boolean): void;
  /** The recorded refusal for a space, if any — lets `openSpace()` reject rather than hope. */
  refusalOf(spaceId: SpaceId): CollabError | undefined;
  /** High-water seq for a space. Exposed for assertions, not for mutation. */
  cursorOf(spaceId: SpaceId): number;
  /** Forget a cursor after a verified node/data epoch change. */
  clearCursor(spaceId: SpaceId): void;
  dispose(): void;
}

/**
 * `nextCursor` → a usable `since`, or null.
 *
 * Explicit rather than a bare `Number()` because `Number('')`, `Number(null)`
 * and `Number([])` are all 0, and a cursor that quietly became 0 would replay
 * the entire retained log on every poll. Only non-negative safe integers are
 * schema-legal; anything else falls back to the observed high-water instead.
 */
export function toCursor(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

interface SpaceRuntime {
  pollTimer: unknown;
  pollInFlight: boolean;
  accelerateTimer: unknown;
}

export function createConnectionManager(deps: ConnectionDeps): ConnectionManager {
  const cfg: ConnectionConfig = { ...DEFAULT_CONNECTION_CONFIG, ...deps.config };
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const onError = deps.onError ?? (() => {});

  const open = new Set<SpaceId>();
  const cursors = new Map<SpaceId, number>();
  const runtime = new Map<SpaceId, SpaceRuntime>();
  const refusals = new Map<SpaceId, CollabError>();
  const prepareEpochs = new Map<SpaceId, number>();
  const preparing = new Map<SpaceId, { epoch: number; promise: Promise<number> }>();

  const eventSubs = new Set<(e: DurableWorkspaceEvent) => void>();
  const chatTurnSubs = new Set<(frame: ChatTurnFrame) => void>();
  const connSubs = new Set<(s: ConnectionState) => void>();
  const resyncSubs = new Set<(spaceId: SpaceId) => void>();
  const refusedSubs = new Set<(spaceId: SpaceId, error: CollabError) => void>();
  const reconnectSubs = new Set<() => void>();

  let socket: SocketHandle | null = null;
  let phase: ConnectionState = { phase: 'connecting' };
  let disconnectedAtMs: number | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown = null;
  let transportOk = true;
  let disposed = false;
  /** Set the moment a socket is requested; cleared when it closes. */
  let connecting = false;

  // -- plumbing --------------------------------------------------------------

  function fanout<A extends unknown[]>(subs: Set<(...a: A) => void>, ...args: A): void {
    for (const cb of subs) {
      // One bad listener must not stall the stream for the others, and must not
      // stall the cursor either.
      try { cb(...args); } catch (err) { onError(err, 'listener'); }
    }
  }

  function setPhase(next: ConnectionState): void {
    if (next.phase === phase.phase) {
      // `disconnectedSince` is stamped once per disconnect, so an identical
      // phase is genuinely a no-op — re-emitting would make every poll tick
      // look like a state change to the UI.
      return;
    }
    phase = next;
    fanout(connSubs, next);
  }

  function sinceIso(): string {
    return new Date(disconnectedAtMs ?? now()).toISOString();
  }

  function rt(spaceId: SpaceId): SpaceRuntime {
    let r = runtime.get(spaceId);
    if (r === undefined) {
      r = { pollTimer: null, pollInFlight: false, accelerateTimer: null };
      runtime.set(spaceId, r);
    }
    return r;
  }

  // -- THE dispatch path (WS and poll both land here) ------------------------

  function dispatch(event: DurableWorkspaceEvent): void {
    if (disposed) return;
    lastInboundAtMs = now();
    // Events are delivered only for OPEN spaces — the seam's own wording.
    if (!open.has(event.spaceId)) return;
    const last = cursors.get(event.spaceId) ?? 0;
    if (event.seq <= last) return;
    cursors.set(event.spaceId, event.seq);
    deps.onCursor?.(event.spaceId, event.seq);
    fanout(eventSubs, event);
  }

  function dispatchChatTurn(frame: ChatTurnFrame): void {
    if (disposed) return;
    lastInboundAtMs = now();
    fanout(chatTurnSubs, frame);
  }

  // -- half-open watchdog ----------------------------------------------------
  //
  // The one disconnection this state machine could not see: a socket whose
  // peer died WITHOUT a FIN (sleep/wake, network switch, killed server). The
  // browser fires no `close`, `phase` stays `live`, the poll fallback never
  // engages, and the UI silently stops advancing. There is no client-visible
  // heartbeat (protocol pings are answered below JS), and inbound silence
  // alone must not read as death — a quiet workspace is quiet.
  //
  // So the watchdog asks the one question that distinguishes them: after
  // `idleProbeAfterMs` of inbound silence, poll the durable log from the
  // current cursor. Items found = the log advanced while the socket sat
  // silent = the socket is not delivering: dispatch what the probe found (the
  // ordinary path — the seq law dedupes) and close the socket, which engages
  // the normal fallback-and-backoff machinery. Nothing found = quiet really
  // was quiet; the probe itself is fresh evidence the node answers.

  let lastInboundAtMs = now();
  let idleTimer: unknown = null;
  let idleProbeInFlight = false;

  function stopIdleWatchdog(): void {
    if (idleTimer !== null) {
      timers.clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleCheck(): void {
    if (disposed || idleTimer !== null) return;
    idleTimer = timers.setTimeout(() => {
      idleTimer = null;
      void idleCheck().finally(() => {
        if (!disposed && socket !== null && socket.isOpen()) scheduleIdleCheck();
      });
    }, cfg.idleCheckIntervalMs);
  }

  async function idleCheck(): Promise<void> {
    if (disposed || socket === null || !socket.isOpen()) return;
    if (idleProbeInFlight) return;
    if (now() - lastInboundAtMs < cfg.idleProbeAfterMs) return;
    idleProbeInFlight = true;
    try {
      for (const spaceId of open) {
        const since = cursors.get(spaceId) ?? 0;
        let page: DurableEventPage | undefined;
        try {
          page = await deps.poll(spaceId, since, cfg.pollLimit);
        } catch (err) {
          // The probe could not run — that is transport news the HTTP layer
          // already reported via noteTransport; the next check retries.
          onError(err, 'idle probe');
          return;
        }
        let missed = false;
        for (const raw of page?.items ?? []) {
          if (typeof raw?.seq === 'number' && raw.seq > since) missed = true;
          dispatch(raw);
        }
        if (missed) {
          onError(
            new Error(`space ${spaceId} advanced while the socket sat silent — reconnecting`),
            'idle probe',
          );
          // `SocketHandle.close()` silences its own handlers (socket.ts) —
          // `handleClose` must be driven here, the same way the factory-throw
          // path drives it, or the manager would sit on a closed socket with
          // no fallback and no reconnect.
          socket?.close();
          handleClose();
          return;
        }
      }
      // Probed clean: the node answered and nothing was missed. Count it as
      // liveness evidence so a genuinely quiet workspace is probed on the
      // idle cadence, not hammered on the check cadence.
      lastInboundAtMs = now();
    } finally {
      idleProbeInFlight = false;
    }
  }

  // -- socket ----------------------------------------------------------------

  function resumeAndAccelerate(spaceId: SpaceId): void {
    if (socket === null || !socket.isOpen()) return;
    const since = cursors.get(spaceId) ?? 0;
    socket.resume(spaceId, since);
    scheduleAccelerate(spaceId, since);
  }

  /**
   * Re-resume from the advancing cursor until it stops advancing between
   * rounds. Throughput only (see the header): every event it pulls forward
   * would have arrived from the pump anyway, and the seq law makes the overlap
   * free.
   */
  function scheduleAccelerate(spaceId: SpaceId, cursorAtResume: number): void {
    const r = rt(spaceId);
    if (r.accelerateTimer !== null) timers.clearTimeout(r.accelerateTimer);
    r.accelerateTimer = timers.setTimeout(() => {
      r.accelerateTimer = null;
      if (disposed || !open.has(spaceId)) return;
      if (socket === null || !socket.isOpen()) return;
      const cursor = cursors.get(spaceId) ?? 0;
      if (cursor <= cursorAtResume) return; // caught up — the pump has it from here
      socket.resume(spaceId, cursor);
      scheduleAccelerate(spaceId, cursor);
    }, cfg.accelerateIntervalMs);
  }

  function stopAccelerate(spaceId: SpaceId): void {
    const r = runtime.get(spaceId);
    if (r?.accelerateTimer != null) {
      timers.clearTimeout(r.accelerateTimer);
      r.accelerateTimer = null;
    }
  }

  function handleOpen(): void {
    if (disposed || socket === null) return;
    connecting = false;
    reconnectAttempt = 0;
    stopPollers();

    const spaces = [...open];
    if (spaces.length > 0) socket.subscribe(spaces);

    // The gap is measured BEFORE it is cleared, and resync is emitted BEFORE
    // the resume that re-seeds the cursor — so hydration and re-seed happen
    // together and there is no window where the UI is stale but told it is live.
    const gapMs = disconnectedAtMs === null ? 0 : now() - disconnectedAtMs;
    const reconnected = disconnectedAtMs !== null;
    disconnectedAtMs = null;

    for (const spaceId of spaces) {
      if (gapMs > cfg.resyncGapMs) fanout(resyncSubs, spaceId);
      resumeAndAccelerate(spaceId);
    }

    setPhase({ phase: 'live' });
    lastInboundAtMs = now();
    scheduleIdleCheck();
    if (reconnected) fanout(reconnectSubs);
  }

  function handleRefused(ack: { frame: string; spaceId?: SpaceId; reason: string }): void {
    if (disposed) return;
    if (ack.frame === 'resume') {
      // Catch-up integrity is lost for that space: replay was refused, so the
      // gap cannot be closed from the log. Re-hydrate.
      const targets = ack.spaceId !== undefined ? [ack.spaceId] : [...open];
      for (const spaceId of targets) fanout(resyncSubs, spaceId);
      return;
    }
    if (ack.frame === 'subscribe') {
      // A refused space must never look like a quiet one.
      const targets = ack.spaceId !== undefined ? [ack.spaceId] : [...open];
      for (const spaceId of targets) {
        const err = new CollabError(
          ack.reason === 'malformed' ? 'invalid_input' : 'forbidden',
          `subscribe refused for space ${spaceId} (${ack.reason})`,
          { details: { spaceId, reason: ack.reason } },
        );
        refusals.set(spaceId, err);
        fanout(refusedSubs, spaceId, err);
      }
      return;
    }
    onError(ack, 'control.refused');
  }

  function handleClose(): void {
    socket = null;
    connecting = false;
    stopIdleWatchdog();
    if (disposed) return;
    for (const spaceId of open) stopAccelerate(spaceId);
    if (disconnectedAtMs === null) disconnectedAtMs = now();
    setPhase(transportOk
      ? { phase: 'polling', disconnectedSince: sinceIso() }
      : { phase: 'offline', disconnectedSince: sinceIso() });
    startPollers();
    scheduleReconnect();
  }

  function connect(): void {
    if (disposed || socket !== null || connecting) return;
    connecting = true;
    try {
      socket = openSocket(deps.wsUrl, deps.webSocketFactory, {
        onOpen: handleOpen,
        onEvent: dispatch,
        onChatTurn: dispatchChatTurn,
        onRefused: handleRefused,
        onClose: handleClose,
        onMalformed: (raw, cause) => onError(cause ?? raw, 'malformed frame'),
      });
    } catch (err) {
      // A factory that throws is a socket that will never open. Treat it as a
      // close so backoff and the poll fallback engage instead of stalling in
      // `connecting` forever.
      socket = null;
      onError(err, 'socket factory');
      handleClose();
    }
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null) return;
    const capped = Math.min(cfg.backoffBaseMs * 2 ** reconnectAttempt, cfg.backoffMaxMs);
    // Jitter never drops below half the capped delay: full jitter down to ~0
    // would turn a thundering herd into a hot loop against a node that is
    // already refusing connections.
    const delay = capped * (0.5 + random() * 0.5);
    reconnectAttempt += 1;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // -- resume-on-foreground --------------------------------------------------
  //
  // THE PHONE CASE. The backoff ladder and the 1.5s poller are both written for
  // a tab that stays open. A backgrounded phone gets neither: the OS freezes the
  // poll timer, and a `setTimeout` scheduled for a 0.5-8s reconnect may not run
  // until the app is foregrounded again — at which point the client waits out a
  // delay computed from failures that happened on a network it has since left.
  //
  // So when the app comes back, ask immediately and from a clean ladder. Two
  // things keep this from being "delete the backoff":
  //   - `resumeMinIntervalMs` floors how often the ladder may be reset, so
  //     visibility flapping cannot become a hot loop (see the config comment).
  //   - Nothing here bypasses `connect()`'s own guards, and the socket's
  //     outcome still decides the phase. A resume that fails lands in
  //     `handleClose` and rejoins the ordinary jittered ladder.

  let lastForcedResumeAtMs = Number.NEGATIVE_INFINITY;

  function resumeNow(): void {
    if (disposed) return;
    // Already delivering — a foreground is not news.
    if (socket !== null && socket.isOpen()) return;
    const at = now();
    if (at - lastForcedResumeAtMs < cfg.resumeMinIntervalMs) return;
    lastForcedResumeAtMs = at;

    // The ladder was built against a network this device may no longer be on.
    reconnectAttempt = 0;
    if (reconnectTimer !== null) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();

    // The HTTP fallback was frozen with everything else, so its next tick could
    // be a full interval away (or already overdue and about to fire late). Drop
    // the stale timers and prime it now: if the socket wins the race, `pollTick`
    // sees an open socket and returns without a request.
    for (const spaceId of open) {
      const r = rt(spaceId);
      if (r.pollTimer !== null) {
        timers.clearTimeout(r.pollTimer);
        r.pollTimer = null;
      }
      void pollTick(spaceId);
    }
  }

  // -- poll fallback ---------------------------------------------------------

  function startPollers(): void {
    for (const spaceId of open) startPoller(spaceId);
  }

  function startPoller(spaceId: SpaceId): void {
    const r = rt(spaceId);
    if (r.pollTimer !== null) return;
    // Prime immediately so the fallback is not one interval stale.
    void pollTick(spaceId);
  }

  function stopPollers(): void {
    for (const [, r] of runtime) {
      if (r.pollTimer !== null) {
        timers.clearTimeout(r.pollTimer);
        r.pollTimer = null;
      }
    }
  }

  function schedulePoll(spaceId: SpaceId): void {
    if (disposed || !open.has(spaceId)) return;
    if (socket !== null && socket.isOpen()) return; // WS took over
    const r = rt(spaceId);
    if (r.pollTimer !== null) return;
    r.pollTimer = timers.setTimeout(() => {
      r.pollTimer = null;
      void pollTick(spaceId);
    }, cfg.pollIntervalMs);
  }

  async function pollTick(spaceId: SpaceId): Promise<void> {
    if (disposed || !open.has(spaceId)) return;
    if (socket !== null && socket.isOpen()) return;
    const r = rt(spaceId);
    if (r.pollInFlight) return;
    r.pollInFlight = true;
    const since = cursors.get(spaceId) ?? 0;
    const epoch = prepareEpochs.get(spaceId) ?? 0;
    try {
      const page = await deps.poll(spaceId, since, cfg.pollLimit);
      // The request belongs to the space generation that started it. A
      // close/clear/re-open can make the space open again before this response
      // lands, so `open.has` alone is insufficient: the epoch keeps an old
      // boot's cursor from being checkpointed into the new boot.
      if (disposed || !open.has(spaceId) || (prepareEpochs.get(spaceId) ?? 0) !== epoch) return;
      let highWater = since;
      for (const raw of page?.items ?? []) {
        if (typeof raw?.seq === 'number' && raw.seq > highWater) highWater = raw.seq;
        dispatch(raw);
      }
      // The server's cursor WINS when there is one, because it advances past
      // rows the server examined but did not return (skipped by the mapper) and
      // `highWater` cannot see those. On a page whose rows were all skipped,
      // highWater stays equal to `since`, the next poll asks the same question,
      // and the stream never moves again — that is the wedge this line closes.
      // `Math.max` guards monotonicity: a cursor that rewinds re-delivers.
      const next = toCursor(page?.nextCursor);
      const cursor = Math.max(next ?? highWater, cursors.get(spaceId) ?? 0);
      cursors.set(spaceId, cursor);
      deps.onCursor?.(spaceId, cursor);
      noteTransport(true);
    } catch (err) {
      // A failed poll is not fatal: the next tick retries from the SAME cursor,
      // so nothing is skipped. Only a TRANSPORT failure means offline — a
      // refusal proves the node answered.
      const unreachable = err instanceof CollabError && err.code === 'upstream_unavailable';
      onError(err, 'events.poll');
      noteTransport(!unreachable);
    } finally {
      r.pollInFlight = false;
      schedulePoll(spaceId);
    }
  }

  function noteTransport(reachable: boolean): void {
    transportOk = reachable;
    if (disposed) return;
    // While live, events are flowing — an unrelated HTTP failure is not a
    // disconnection. While connecting, the socket's own outcome decides.
    if (phase.phase === 'live' || phase.phase === 'connecting') return;
    setPhase(reachable
      ? { phase: 'polling', disconnectedSince: sinceIso() }
      : { phase: 'offline', disconnectedSince: sinceIso() });
  }

  /**
   * A prepare generation may be superseded while its HTTP page is in flight.
   * Check immediately after every await, before that response can checkpoint
   * the process-wide cursor. JavaScript runs the following calculation and
   * write atomically, so this guard is the generation's commit barrier.
   */
  function assertPrepareCurrent(spaceId: SpaceId, epoch: number): void {
    if (disposed) throw new Error('connection disposed');
    if ((prepareEpochs.get(spaceId) ?? 0) !== epoch) {
      throw new Error(`event bootstrap cancelled for ${spaceId}`);
    }
  }

  // Subscribed once, for the life of the manager. `resumeNow` is a no-op while
  // the socket is open, so this costs nothing on a desktop tab that never hides.
  const unsubscribeLifecycle = (deps.lifecycle ?? browserLifecycle())(() => resumeNow());

  // -- public surface --------------------------------------------------------

  return {
    prepareSpace(spaceId, since = 0) {
      if (disposed) return Promise.reject(new Error('connection disposed'));
      const epoch = prepareEpochs.get(spaceId) ?? 0;
      const active = preparing.get(spaceId);
      if (active?.epoch === epoch) return active.promise;
      const base = (async () => {
        let cursor = Math.max(0, since, cursors.get(spaceId) ?? 0);
        // A known non-tail cursor must never be used to subscribe: doing so
        // would route the unscanned remainder through Zustand/React and
        // recreate the retained-history freeze. Each real HTTP await yields
        // the main thread; keep walking until the cursor stops advancing.
        for (let pageNumber = 0;; pageNumber += 1) {
          const page = await deps.poll(spaceId, cursor, cfg.pollLimit);
          // `closeSpace`/`clearCursor` may have advanced the epoch while the
          // request was in flight. An obsolete response must not move the
          // cursor (or its persisted mirror) past a newer generation's tail.
          assertPrepareCurrent(spaceId, epoch);
          let observed = cursor;
          for (const event of page.items ?? []) {
            if (typeof event?.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0) {
              observed = Math.max(observed, event.seq);
            }
          }
          const next = toCursor(page.nextCursor);
          // `prepareSpace` is normally awaited before `openSpace`, but the
          // manager's public surface must preserve its own high-water law even
          // if a direct consumer opens early and WS/poll dispatch advances the
          // shared cursor while this page is in flight.
          const advanced = Math.max(observed, next ?? cursor, cursors.get(spaceId) ?? 0);
          if (advanced <= cursor) break;
          cursor = advanced;
          // A completed page is a safe progress checkpoint. Cancellation or
          // a later network failure resumes here instead of scanning it again.
          cursors.set(spaceId, cursor);
          deps.onCursor?.(spaceId, cursor);
          // Under a producer that outruns every 500-row poll, tail may never
          // converge. Surface that honestly and retry from the checkpoint;
          // never subscribe from the known intermediate cursor.
          if (pageNumber + 1 >= cfg.bootstrapPageBudget) {
            throw new Error(
              `event bootstrap for ${spaceId} is still advancing after ${cfg.bootstrapPageBudget} pages; retrying from ${cursor}`,
            );
          }
        }
        assertPrepareCurrent(spaceId, epoch);
        cursors.set(spaceId, cursor);
        deps.onCursor?.(spaceId, cursor);
        return cursor;
      })();
      let task: Promise<number>;
      task = base.finally(() => {
        if (preparing.get(spaceId)?.promise === task) preparing.delete(spaceId);
      });
      preparing.set(spaceId, { epoch, promise: task });
      return task;
    },

    openSpace(spaceId) {
      if (disposed) return;
      const isNew = !open.has(spaceId);
      open.add(spaceId);
      if (!cursors.has(spaceId)) cursors.set(spaceId, 0);
      if (socket !== null && socket.isOpen()) {
        // Already open on a live socket: it is already subscribed AND already
        // resumed, so re-seeding buys nothing but an extra replay round. The
        // seq law would drop the duplicates anyway — this just declines to
        // generate them. (server-owner re-review advisory, 2026-07-28.)
        // NOTE the unconditional resume still lives in `handleOpen`, where it
        // is load-bearing: a fresh socket's subscribe may be silently unseeded.
        if (!isNew) return;
        socket.subscribe([spaceId]);
        resumeAndAccelerate(spaceId);
        return;
      }
      connect();
      if (phase.phase === 'polling' || phase.phase === 'offline') startPoller(spaceId);
    },

    closeSpace(spaceId) {
      prepareEpochs.set(spaceId, (prepareEpochs.get(spaceId) ?? 0) + 1);
      if (!open.delete(spaceId)) return;
      // A refusal is information about a past attempt; a deliberate re-open is
      // allowed to find out whether it still holds.
      refusals.delete(spaceId);
      stopAccelerate(spaceId);
      const r = runtime.get(spaceId);
      if (r?.pollTimer != null) {
        timers.clearTimeout(r.pollTimer);
        r.pollTimer = null;
      }
      // The cursor is KEPT: a re-open in the same page resumes where it left
      // off instead of replaying the retained log from zero.
      socket?.unsubscribe([spaceId]);
    },

    onEvent(cb) { eventSubs.add(cb); return () => { eventSubs.delete(cb); }; },
    onChatTurn(cb) { chatTurnSubs.add(cb); return () => { chatTurnSubs.delete(cb); }; },
    onConnection(cb) { connSubs.add(cb); return () => { connSubs.delete(cb); }; },
    onResync(cb) { resyncSubs.add(cb); return () => { resyncSubs.delete(cb); }; },
    onSpaceRefused(cb) { refusedSubs.add(cb); return () => { refusedSubs.delete(cb); }; },
    onReconnect(cb) { reconnectSubs.add(cb); return () => { reconnectSubs.delete(cb); }; },

    getConnection() { return phase; },
    noteTransport,
    refusalOf(spaceId) { return refusals.get(spaceId); },
    cursorOf(spaceId) { return cursors.get(spaceId) ?? 0; },
    clearCursor(spaceId) {
      if (open.has(spaceId)) return;
      prepareEpochs.set(spaceId, (prepareEpochs.get(spaceId) ?? 0) + 1);
      cursors.delete(spaceId);
      refusals.delete(spaceId);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeLifecycle();
      stopPollers();
      stopIdleWatchdog();
      for (const spaceId of open) stopAccelerate(spaceId);
      if (reconnectTimer !== null) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
      socket?.close();
      socket = null;
      open.clear();
      eventSubs.clear();
      chatTurnSubs.clear();
      connSubs.clear();
      resyncSubs.clear();
      refusedSubs.clear();
      reconnectSubs.clear();
      preparing.clear();
      prepareEpochs.clear();
    },
  };
}
