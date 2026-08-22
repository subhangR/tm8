/**
 * THE PUSH — what turns "the graph announces" into "the socket delivers" for
 * session liveness.
 *
 * ## The defect this closes
 *
 * `execution.liveness` (A21) is the one authority on "is there actually a live
 * terminal", and until this file the ONLY way for a client to consult it was an
 * HTTP read. The client's cadence (`data/real/liveness.ts`) says so in its own
 * header: *"Read-on-demand only — there is deliberately NO liveness-change
 * event (R3), so nothing here waits for a push."*
 *
 * So the shape was: the PTY changes → the graph is written → the durable pump
 * notices on its next tick (`DEFAULT_PUMP_INTERVAL_MS = 1_000`) → the client is
 * told a work_session changed → **the client makes an HTTP round trip to ask
 * what**. Measured on a node with nine live sessions, that last leg alone was
 * p50 298 ms / max 489 ms, on top of up to a second of pump wait.
 *
 * That is announce-without-deliver, and it is what T-L10 forbids: the database
 * was in the streaming hot path, once per transition per client. This file
 * carries the ANSWER instead of a reason to go and look for one.
 *
 * ## What makes it cheap
 *
 * Everything here is in-process and I/O-free. The node ALREADY knows every
 * transition at the instant it happens — it spawned the PTY, it reaped it, its
 * own quiescence timer decided it went quiet. No query is made to learn any of
 * it, and none is made to publish it.
 *
 * ## What makes it bounded
 *
 * The maps are keyed by LIVE sessions and nothing else: an entry is written
 * when a PTY appears and deleted when it vanishes. A space with 519 historical
 * sessions and two live ones costs two entries. The published payload is the
 * live set FOR ONE SPACE, so its size is bounded by the node's session cap
 * (tens), never by history.
 *
 * ## What it will not do
 *
 * It will not publish for a session whose space it does not know. That is a
 * deliberate refusal rather than a lookup: resolving the space would mean a
 * query on the hot path, which is the thing being removed. A session registered
 * through `noteAppeared` always has one; anything else is a bookkeeping gap and
 * the 30s fallback read still covers it. Silence here degrades to the old
 * behaviour — it never produces a wrong live set.
 */
import type { EntityId, LivenessConfidence, LivenessTransition, SpaceId } from '@tm8/contract';

import type { WorkspaceEventPublisher } from './emitter.js';

/**
 * The sink the execution layer calls. Deliberately the smallest surface that
 * can carry the four transitions, so `SpawnService` depends on an interface it
 * could satisfy with a stub rather than on the server's event machinery.
 */
export interface SessionLivenessSink {
  /** A PTY for `sessionId` now exists, in `spaceId`. */
  noteAppeared(sessionId: string, spaceId: string): void;
  /**
   * The PTY is gone. Called on EVERY exit path including the one that writes
   * nothing to the graph — see `handlePtyExit`'s no-captured-claims branch,
   * which logs "expect a ghost session" and returns. That branch produces no
   * durable event at all, so before this sink it was invisible to a client
   * until the next 30s read; now it is the one push that still fires.
   */
  noteVanished(sessionId: string): void;
  /** The PTY went quiet, or started talking again. */
  noteActivity(sessionId: string, activity: 'busy' | 'idle'): void;
}

/** A sink that does nothing, for hosts built without an event publisher. */
export const NULL_LIVENESS_SINK: SessionLivenessSink = {
  noteAppeared: () => {},
  noteVanished: () => {},
  noteActivity: () => {},
};

export interface LivenessBroadcasterDeps {
  readonly publisher: WorkspaceEventPublisher;
  /** `NODE_BOOT_ID`. A change tells a client every previously-live PTY is gone. */
  readonly nodeBootId: string;
  /** Non-fatal publish failures. A failed push must never reach the PTY host. */
  readonly onError?: (message: string) => void;
  /** Injectable clock, so a test can assert `checkedAt` without racing one. */
  readonly now?: () => Date;
}

export interface LivenessBroadcaster extends SessionLivenessSink {
  /** The live sessions this broadcaster believes are in `spaceId`. Test/debug. */
  liveIn(spaceId: string): EntityId[];
  /** How many live sessions are tracked node-wide. The bound, made assertable. */
  size(): number;
}

/**
 * The evidence tier for each transition, per DESIGN 2 (#507) — a table rather
 * than an `if`, because the whole point of the tier is that it is a PROPERTY OF
 * THE TRANSITION and not a judgement made at the call site.
 *
 * `appeared` / `vanished` are `reported`: this process spawned the terminal and
 * this process reaped it. There is no inference.
 *
 * `woke` / `quiet` are `guessed`: they come from `PtyHostService`'s quiescence
 * timer, which observes stream silence and cannot tell an agent thinking hard
 * from one stopped at a permission prompt from one that crashed quietly. #507's
 * central rule is that this distinction must ride on the wire rather than live
 * in a source comment, and this table is where it does.
 */
const CONFIDENCE_OF: Readonly<Record<LivenessTransition, LivenessConfidence>> = {
  appeared: 'reported',
  vanished: 'reported',
  woke: 'guessed',
  quiet: 'guessed',
};

export function createLivenessBroadcaster(deps: LivenessBroadcasterDeps): LivenessBroadcaster {
  const now = deps.now ?? (() => new Date());
  /** sessionId → spaceId, for LIVE sessions only. Deleted on vanish. */
  const spaceOf = new Map<string, string>();
  /** spaceId → live sessionIds. The reverse index, so a publish is not a scan. */
  const liveBySpace = new Map<string, Set<string>>();

  function publish(spaceId: string, changed: { id: string; transition: LivenessTransition }): void {
    const live = liveBySpace.get(spaceId);
    try {
      deps.publisher.publishLiveness(spaceId as SpaceId, {
        type: 'execution.liveness_changed',
        nodeBootId: deps.nodeBootId,
        // A fresh array per publish: the Set is mutable and shared, and handing
        // out a live view of it would let a later transition retroactively
        // change what an already-sent event said.
        liveEntityIds: live === undefined ? [] : ([...live] as EntityId[]),
        changed: { id: changed.id as EntityId, transition: changed.transition },
        confidence: CONFIDENCE_OF[changed.transition],
        checkedAt: now().toISOString(),
      });
    } catch (error) {
      // A publish failure must NEVER propagate. This is called synchronously
      // from the PTY host's own callbacks; a throw here would travel back into
      // the terminal's lifecycle handling, and a UI-freshness feature is not
      // allowed to break the thing it reports on.
      deps.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    noteAppeared(sessionId, spaceId) {
      const previous = spaceOf.get(sessionId);
      // A re-appear in a DIFFERENT space (a resume that moved, or a reused id)
      // must leave the old space's set behind rather than orphaning an entry
      // there that nothing will ever delete.
      if (previous !== undefined && previous !== spaceId) {
        liveBySpace.get(previous)?.delete(sessionId);
        publish(previous, { id: sessionId, transition: 'vanished' });
      }
      spaceOf.set(sessionId, spaceId);
      let set = liveBySpace.get(spaceId);
      if (set === undefined) {
        set = new Set();
        liveBySpace.set(spaceId, set);
      }
      set.add(sessionId);
      publish(spaceId, { id: sessionId, transition: 'appeared' });
    },

    noteVanished(sessionId) {
      const spaceId = spaceOf.get(sessionId);
      // Not tracked ⇒ nothing to say. Publishing a `vanished` for a session
      // this broadcaster never saw appear would be an assertion about a live
      // set it does not hold, and the set it published would be missing that
      // session's peers too.
      if (spaceId === undefined) return;
      spaceOf.delete(sessionId);
      const set = liveBySpace.get(spaceId);
      set?.delete(sessionId);
      if (set !== undefined && set.size === 0) liveBySpace.delete(spaceId);
      // Published AFTER the removal, so `liveEntityIds` is the set as it is now
      // and not as it was a moment ago. A client that trusted the payload over
      // its own bookkeeping would otherwise re-add the session it was just told
      // had died.
      publish(spaceId, { id: sessionId, transition: 'vanished' });
    },

    noteActivity(sessionId, activity) {
      const spaceId = spaceOf.get(sessionId);
      if (spaceId === undefined) return;
      // Membership is NOT touched here. Going quiet is not dying: a session
      // that stops talking still holds a live PTY, and dropping it from the
      // live set would make the client render it `stale` — which is the exact
      // "the spinner lied" failure in reverse.
      publish(spaceId, { id: sessionId, transition: activity === 'idle' ? 'quiet' : 'woke' });
    },

    liveIn(spaceId) {
      const set = liveBySpace.get(spaceId);
      return set === undefined ? [] : ([...set] as EntityId[]);
    },

    size() {
      return spaceOf.size;
    },
  };
}
