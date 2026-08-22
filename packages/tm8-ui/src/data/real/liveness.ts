/**
 * Session liveness (LLD §9 / Delta 2, consensus shape C-1) — and the R-UI-5
 * predicate, which is the ONLY place in the whole UI where liveness truth is
 * computed.
 *
 *     statusOf(s):  status ∉ {running, idle}  → 'not-running'
 *                   no snapshot / snapshot > 90s  → 'unknown'   (neutral, NEVER live)
 *                   s.id ∈ live set               → 'live'
 *                   otherwise                     → 'stale'
 *
 * The 'unknown' row is the entire point of the rule and the easiest one to
 * quietly lose: a session whose liveness we cannot currently establish is NOT
 * live, and it is not stale either — claiming either would be a green badge
 * over an absence. It renders neutral. `recordedStatus` (`status`) comes
 * from the entity cache, never from this read (C-1).
 *
 * Cadence (LLD §9, as amended): on `openSpace` · on `entity.upsert` whose
 * entity is a `work_session` · on `entity.activity_touched` whose `kind` is
 * `work_session` · on WS reconnect · on a 30s slow interval while a session
 * surface is visible · AND, since the liveness push landed, on
 * `execution.liveness_changed` arriving on the socket.
 *
 * ## The push, and what it changed about this file
 *
 * This header used to end "Read-on-demand only — there is deliberately NO
 * liveness-change event (R3), so nothing here waits for a push." That sentence
 * described the defect. The consequence was that every path above is a NUDGE —
 * it says something moved and this manager then spends an HTTP round trip
 * asking the node WHAT (measured p50 298ms against a node with nine live
 * sessions). Under T-L10 the graph may announce and the socket must deliver;
 * announcing and then making the client query is the database sitting in the
 * streaming hot path once per transition per client.
 *
 * `notePush` applies the answer directly. The event carries the FULL live set
 * for its space, so applying it is idempotent, a dropped frame self-heals on
 * the next one, and no read is issued at all.
 *
 * ## The interval is still here, and is now honestly a fallback
 *
 * 30s is retained unchanged — not as the delivery mechanism but as the thing
 * that notices what a push cannot: a node that died without closing sockets, a
 * space whose pushes were lost, a transition on a node built without a
 * broadcaster. Deleting it would trade a 30s worst case for an unbounded one.
 *
 * ## Pushed freshness is REAL freshness, and is tracked separately
 *
 * A snapshot's age is measured from `checkedAt`, and a push sets that to the
 * instant the PTY moved — so a pushed snapshot is fresher than a read one, not
 * merely as fresh. `pushedAt` is recorded alongside so a consumer can tell "the
 * node told me" from "I asked 89 seconds ago and it has not aged out yet".
 * Those are different degrees of knowledge and the honesty rule below (the
 * whole reason `unknown` exists) is about not collapsing them.
 *
 * A `nodeBootId` change between snapshots means the node process restarted and
 * every previously-live PTY is gone. That is not a data refresh, it is an
 * invalidation: cached snapshots for other spaces are dropped and re-read
 * immediately rather than aged out. A push carries `nodeBootId` too, so the
 * restart is detected on the same rule whichever way the snapshot arrived.
 */
import type {
  DurableWorkspaceEvent,
  LivenessChangedEvent,
  LivenessConfidence,
  SpaceId,
} from '@tm8/contract';
import type { LivenessSnapshot, SessionLiveness, Unsubscribe } from '../seam';
import type { Seam } from '../seam';
import { realTimers, type Timers } from './connection';

export interface LivenessConfig {
  /** A snapshot older than this is not evidence of anything (LLD §9: 90s). */
  staleAfterMs: number;
  /** Slow re-read while a session surface is visible (LLD §9: 30s). */
  intervalMs: number;
}

export const DEFAULT_LIVENESS_CONFIG: LivenessConfig = {
  staleAfterMs: 90_000,
  intervalMs: 30_000,
};

export interface LivenessDeps {
  /** `GET /v2/spaces/:spaceId/execution/liveness`. Supplied by `ops.ts`. */
  read(spaceId: SpaceId): Promise<LivenessSnapshot>;
  timers?: Timers;
  now?: () => number;
  config?: Partial<LivenessConfig>;
  onError?: (error: unknown, context: string) => void;
}

export interface LivenessManager {
  refresh(spaceId: SpaceId): Promise<LivenessSnapshot>;
  onChange(cb: (snap: LivenessSnapshot) => void): Unsubscribe;
  statusOf(session: Parameters<Seam['liveness']['statusOf']>[0]): SessionLiveness;
  /** The node restarted — every previously-live PTY is gone; re-read open session surfaces. */
  onNodeRestart(cb: (nodeBootId: string) => void): Unsubscribe;
  // -- cadence hooks (LLD §9) ----------------------------------------------
  noteSpaceOpened(spaceId: SpaceId): void;
  noteSpaceClosed(spaceId: SpaceId): void;
  /** Feed the event stream in; a work_session upsert triggers a re-read. */
  noteEvent(event: DurableWorkspaceEvent): void;
  /**
   * Apply a pushed liveness snapshot. NO READ IS ISSUED — this is the answer,
   * not a reason to go and ask for one.
   */
  notePush(event: LivenessChangedEvent): void;
  /**
   * The evidence tier behind the node's last statement about this session, or
   * null when it has made none and a periodic read is all there is (#507).
   */
  confidenceOf(sessionId: string): LivenessConfidence | null;
  /** True when this space's current snapshot was PUSHED rather than read. */
  wasPushed(spaceId: SpaceId): boolean;
  noteReconnect(): void;
  /** Start/stop the slow interval. Off by default — an invisible surface polls nothing. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createLivenessManager(deps: LivenessDeps): LivenessManager {
  const cfg: LivenessConfig = { ...DEFAULT_LIVENESS_CONFIG, ...deps.config };
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? (() => Date.now());
  const onError = deps.onError ?? (() => {});

  const snapshots = new Map<SpaceId, LivenessSnapshot>();
  /** One in-flight read per space (LLD §9). A second caller joins the first. */
  const inFlight = new Map<SpaceId, Promise<LivenessSnapshot>>();
  /** Local receipt time of the last push per space. HOW we know, not WHAT. */
  const pushedAt = new Map<SpaceId, number>();
  /**
   * The last evidence tier the node reported ABOUT ONE SESSION (#507).
   *
   * Kept per session rather than per space because that is the grain the
   * distinction has: in one space, a session that just exited is `reported`
   * (the node reaped the process) while a session that merely went quiet is
   * `guessed` (a silence timer fired, and silence cannot tell an agent thinking
   * hard from one stopped at a permission prompt). Collapsing them to a
   * per-space tier would relabel one of the two, which is the lie the tier
   * exists to prevent.
   *
   * Bounded by LIVE sessions: an entry is written when the node speaks about a
   * session and dropped when that session leaves every live set below.
   */
  const confidence = new Map<string, LivenessConfidence>();
  const tracked = new Set<SpaceId>();
  const changeSubs = new Set<(snap: LivenessSnapshot) => void>();
  const restartSubs = new Set<(nodeBootId: string) => void>();

  let nodeBootId: string | null = null;
  let intervalTimer: unknown = null;
  let visible = false;
  let disposed = false;

  function freshness(snap: LivenessSnapshot): number | null {
    const at = Date.parse(snap.checkedAt);
    // An unparseable timestamp is not a fresh one. Treating it as fresh would
    // be the exact substitution R-UI-5 forbids.
    return Number.isFinite(at) ? now() - at : null;
  }

  function isFresh(snap: LivenessSnapshot): boolean {
    const age = freshness(snap);
    return age !== null && age <= cfg.staleAfterMs;
  }

  function record(snap: LivenessSnapshot): LivenessSnapshot {
    snapshots.set(snap.spaceId, snap);
    const restarted = nodeBootId !== null && nodeBootId !== snap.nodeBootId;
    nodeBootId = snap.nodeBootId;

    if (restarted) {
      // Every other cached snapshot describes a process that no longer exists.
      // Drop them first so nothing can read a stale live-set in the window
      // before the re-reads land, then re-read.
      for (const spaceId of [...snapshots.keys()]) {
        if (spaceId !== snap.spaceId) snapshots.delete(spaceId);
      }
      for (const cb of restartSubs) {
        try { cb(snap.nodeBootId); } catch (err) { onError(err, 'liveness restart listener'); }
      }
      for (const spaceId of tracked) {
        if (spaceId !== snap.spaceId) void refresh(spaceId).catch(() => {});
      }
    }

    for (const cb of changeSubs) {
      try { cb(snap); } catch (err) { onError(err, 'liveness listener'); }
    }
    return snap;
  }

  function refresh(spaceId: SpaceId): Promise<LivenessSnapshot> {
    const existing = inFlight.get(spaceId);
    if (existing !== undefined) return existing;
    const p = deps.read(spaceId)
      .then((snap) => (disposed ? snap : record(snap)))
      .finally(() => { inFlight.delete(spaceId); });
    inFlight.set(spaceId, p);
    return p;
  }

  /** Fire-and-forget cadence trigger: a failed refresh must never reject upward. */
  function nudge(spaceId: SpaceId): void {
    if (disposed) return;
    void refresh(spaceId).catch((err: unknown) => onError(err, 'execution.liveness'));
  }

  function retick(): void {
    if (intervalTimer !== null) { timers.clearTimeout(intervalTimer); intervalTimer = null; }
    if (disposed || !visible || tracked.size === 0) return;
    intervalTimer = timers.setTimeout(() => {
      intervalTimer = null;
      for (const spaceId of tracked) nudge(spaceId);
      retick();
    }, cfg.intervalMs);
  }

  return {
    refresh,
    onChange(cb) { changeSubs.add(cb); return () => { changeSubs.delete(cb); }; },
    onNodeRestart(cb) { restartSubs.add(cb); return () => { restartSubs.delete(cb); }; },

    /**
     * THE predicate. Note what it is satisfied by, since that is the whole
     * question: 'live' requires this id to appear in a snapshot that is BOTH
     * present and fresh. Absence of evidence resolves to 'unknown', never to
     * 'stale' and never to 'live'.
     *
     * Membership is checked across every fresh snapshot rather than against the
     * session's own space, because this layer holds no entity cache to resolve
     * an id to a space — and it does not need one: `liveEntityIds` are entity
     * ids, unique node-wide. The fixture implementation resolves the space from
     * its dataset first; with one snapshot per open space the two agree, and
     * with several they still agree, because an id can only be live in the
     * space that owns it.
     */
    statusOf(session): SessionLiveness {
      // `idle` means the agent is quiet, not that its PTY exited. The live-set
      // snapshot remains authoritative for both running and idle records.
      const recorded = session.status as string | null;
      if (recorded !== 'running' && recorded !== 'idle') return 'not-running';
      let sawFresh = false;
      for (const snap of snapshots.values()) {
        if (!isFresh(snap)) continue;
        sawFresh = true;
        if (snap.liveEntityIds.includes(session.id)) return 'live';
      }
      return sawFresh ? 'stale' : 'unknown';
    },

    noteSpaceOpened(spaceId) {
      tracked.add(spaceId);
      nudge(spaceId);
      retick();
    },

    noteSpaceClosed(spaceId) {
      tracked.delete(spaceId);
      snapshots.delete(spaceId);
      // The provenance dies with the snapshot it described. Leaving it would
      // let a re-opened space inherit a tier established for a live set that is
      // no longer held — a stale claim about how well we know something.
      pushedAt.delete(spaceId);
      retick();
    },

    noteEvent(event) {
      // TWO branches, and the second one is not optional.
      //
      // Migration 165 stopped emitting a full `entity.upsert` for a row whose
      // only mover was `activity_at`, and a work_session's activity is exactly
      // that shape: a message lands on it, an edge is written to it. Measured
      // on the live graph, 19,708 of the 25,149 work_session events were
      // recency-only against 26 semantic ones — so without this branch the
      // cadence collapses from near-instant to the 30s slow interval, and a
      // session reads 'unknown' for 90s. The thin event has no `.entity`,
      // which is why `kind` is on its payload.
      if (event.type === 'entity.activity_touched') {
        if (event.kind !== 'work_session') return;
        nudge(event.spaceId);
        return;
      }
      if (event.type !== 'entity.upsert') return;
      if (event.entity.state.kind !== 'work_session') return;
      nudge(event.spaceId);
    },

    /**
     * THE PUSH PATH. Everything above this reacts to a hint by making a
     * request; this one is handed the answer.
     *
     * ## Why the whole set is taken rather than the delta applied
     *
     * The event names the session that moved AND carries the full live set for
     * its space. Only the set is used. Applying `changed` to a locally-held set
     * would make this fold order-dependent and unrecoverable: one dropped frame
     * and the client's set is permanently wrong in a way nothing detects.
     * Taking the set wholesale means a dropped frame costs one stale render and
     * the next push repairs it. `changed` is carried for CONSUMERS — a surface
     * that wants to animate the one row that moved — not for this fold.
     *
     * ## Why an unknown space is still recorded
     *
     * No `tracked` guard. A push arrives only for a space the connection has
     * open (the dispatch path enforces that), and refusing to record one for a
     * space this manager has not been told about would silently drop the first
     * push after `openSpace` — the exact moment a person is most likely to be
     * looking at the screen.
     *
     * ## Freshness comes from the node, not from here
     *
     * `checkedAt` is the server's stamp at the moment the PTY moved. It is
     * NOT restamped with the local clock: doing so would paper over a client
     * whose clock is skewed or a frame that sat in a buffer, and the 90s
     * staleness rule exists precisely to catch that. A push that somehow
     * arrives already stale reads as stale, which is the honest answer.
     */
    notePush(event) {
      if (disposed) return;
      record({
        spaceId: event.spaceId,
        liveEntityIds: [...event.liveEntityIds],
        nodeBootId: event.nodeBootId,
        checkedAt: event.checkedAt,
        // DELIBERATELY ABSENT, both of them.
        //
        // `capacity` and `eventHwm` are facts the HTTP read establishes with
        // queries the PTY host does not make and must not start making — the
        // whole claim of this path is that nothing on it touches the database.
        // Carrying a stale copy of either would be worse than carrying none:
        // `eventHwm` in particular seeds the durable event cursor, and a
        // wrong one replays or skips real history.
        //
        // `ops.liveness` normalises both to null for a node that omits them,
        // so consumers already handle their absence — this is the same shape,
        // not a new one. The next scheduled read repopulates them.
      });
      pushedAt.set(event.spaceId, now());
      if (event.changed !== null && event.confidence !== null) {
        confidence.set(event.changed.id, event.confidence);
      }
      /* Forget the tier for anything no longer live ANYWHERE. Kept here rather
         than in `record` because only a push can establish a tier in the first
         place — an HTTP read carries no provenance, which is #507's original
         complaint about the shipped signal. */
      for (const sessionId of [...confidence.keys()]) {
        let stillLive = false;
        for (const snap of snapshots.values()) {
          if (snap.liveEntityIds.includes(sessionId)) { stillLive = true; break; }
        }
        if (!stillLive) confidence.delete(sessionId);
      }
    },

    /**
     * How the node knows what it last said about this session, or null when it
     * has not said anything and this manager is going on a periodic read.
     *
     * NULL IS THE IMPORTANT RETURN and the reason this is exposed at all. A
     * consumer that renders a session's state without consulting this is
     * presenting a poll result — which is an inference from a snapshot up to 90
     * seconds old — with the same confidence as a fact the node reported at the
     * instant it happened. #507's whole argument is that those must be
     * distinguishable on the wire and on the screen; this is where the screen
     * gets to ask.
     */
    confidenceOf(sessionId) {
      return confidence.get(sessionId) ?? null;
    },

    /** True when this space's snapshot arrived as a push rather than a read. */
    wasPushed(spaceId) {
      const at = pushedAt.get(spaceId);
      const snap = snapshots.get(spaceId);
      if (at === undefined || snap === undefined) return false;
      // A read that landed AFTER the last push supersedes it — the snapshot
      // held is the read's, so claiming it was pushed would misreport its
      // provenance even though both are current.
      const checked = Date.parse(snap.checkedAt);
      return Number.isFinite(checked) && at >= checked;
    },

    noteReconnect() {
      for (const spaceId of tracked) nudge(spaceId);
    },

    setVisible(next) {
      if (visible === next) return;
      visible = next;
      // Becoming visible re-reads immediately: an interval that only fires in
      // 30s would leave the surface rendering a snapshot that may already have
      // aged past the 90s window, i.e. showing 'unknown' when the answer is a
      // request away.
      if (next) for (const spaceId of tracked) nudge(spaceId);
      retick();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (intervalTimer !== null) { timers.clearTimeout(intervalTimer); intervalTimer = null; }
      snapshots.clear();
      pushedAt.clear();
      confidence.clear();
      tracked.clear();
      inFlight.clear();
      changeSubs.clear();
      restartSubs.clear();
    },
  };
}
