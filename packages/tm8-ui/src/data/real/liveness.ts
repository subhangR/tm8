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
 * Cadence (LLD §9): on `openSpace` · on `entity.upsert` whose entity is a
 * `work_session` · on WS reconnect · on a 30s slow interval while a session
 * surface is visible. Read-on-demand only — there is deliberately NO
 * liveness-change event (R3), so nothing here waits for a push.
 *
 * A `nodeBootId` change between snapshots means the node process restarted and
 * every previously-live PTY is gone. That is not a data refresh, it is an
 * invalidation: cached snapshots for other spaces are dropped and re-read
 * immediately rather than aged out.
 */
import type { DurableWorkspaceEvent, SpaceId } from '@tm8/contract';
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
      retick();
    },

    noteEvent(event) {
      if (event.type !== 'entity.upsert') return;
      if (event.entity.state.kind !== 'work_session') return;
      nudge(event.spaceId);
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
      tracked.clear();
      inFlight.clear();
      changeSubs.clear();
      restartSubs.clear();
    },
  };
}
