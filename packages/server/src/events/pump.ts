/**
 * The live durable publisher — the thing that was missing.
 *
 * `WorkspaceEventPublisher.publishDurable` had ZERO production callers before
 * this file, so however good the socket, the fan-out and the log were, no
 * durable event ever reached a client. That, and not "the sequence is in
 * memory", was the real defect behind the standing risk note: the sequence is a
 * committed table row and always was, but nothing published from it.
 *
 * ## Why it polls instead of listening
 *
 * `LISTEN`/`NOTIFY` would be lower latency, but the capture trigger does not
 * emit a notification and adding one is a migration this lane may not land.
 * Polling the log the clients could poll themselves needs no schema change and
 * reuses the exact read `events.poll` is already proven on.
 *
 * ## Why it polls PER CONNECTION rather than per Space
 *
 * This is the load-bearing decision. `workspace_events` interleaves two feeds
 * (003:277): rows with `recipient_member_id IS NULL` are the Space feed, rows
 * with one set are a single member's notifications, and `workspace_events_select`
 * (008:156-161) lets a member read the Space's rows plus their own.
 *
 * A per-Space pump would have to read under SOME member's claims and then fan
 * the result out to every subscriber — handing that member's private
 * notifications to everyone else in the Space. The read would be perfectly
 * authorized; the leak would happen afterwards, in the fan-out. So each
 * connection reads with its own claims and receives only its own rows, and
 * delivery goes through `publishDurableTo` rather than the broadcast path.
 *
 * The cost is one query per connection per tick instead of one per Space. For a
 * node whose whole premise is one workspace that is the right trade, and it is
 * the only version that is correct.
 */
import type { DurableWorkspaceEvent } from '@tm8/contract';

import type { DbClaims } from '../db/types.js';
import type { RequestIdentity } from '../http/types.js';
import type { WorkspaceEventPublisher } from './emitter.js';
import type { DurableEventLog } from './poll.js';
import type { SubscriptionRegistry } from './subscriptions.js';
import type { EventSink } from './ws-connection.js';

export interface DurableEventPumpDeps {
  readonly registry: SubscriptionRegistry;
  readonly publisher: WorkspaceEventPublisher;
  readonly log: DurableEventLog;
  readonly claimsFor: (identity: RequestIdentity) => Promise<DbClaims>;
  /** Poll interval. Injectable so tests need not wait. */
  readonly intervalMs?: number;
  /** Events per connection per Space per tick. */
  readonly batch?: number;
  readonly onError?: (message: string) => void;
}

export interface DurableEventPump {
  /** Run one tick immediately. Returns how many events were delivered. */
  tick(): Promise<number>;
  start(): void;
  stop(): void;
  /**
   * Set a connection's starting cursor for a Space, so it is not replayed the
   * whole retained log on subscribe. `resume` is how a client asks for history.
   */
  seed(connId: string, spaceId: string, seq: number): void;
  forget(connId: string): void;
}

export const DEFAULT_PUMP_INTERVAL_MS = 1_000;
export const DEFAULT_PUMP_BATCH = 200;

export function createDurableEventPump(deps: DurableEventPumpDeps): DurableEventPump {
  const intervalMs = deps.intervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
  const batch = deps.batch ?? DEFAULT_PUMP_BATCH;
  /** connId → spaceId → last seq delivered to THAT connection. */
  const cursors = new Map<string, Map<string, number>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  function cursorsFor(connId: string): Map<string, number> {
    let bySpace = cursors.get(connId);
    if (bySpace === undefined) {
      bySpace = new Map();
      cursors.set(connId, bySpace);
    }
    return bySpace;
  }

  async function pumpOne(sink: EventSink, spaceId: string): Promise<number> {
    const bySpace = cursorsFor(sink.id);
    const since = bySpace.get(spaceId);

    // NO CURSOR MEANS NO LIVE DELIVERY. There is deliberately no `?? 0` here.
    //
    // This used to default to 0, which made a fresh `subscribe` push up to a
    // whole batch of RETAINED HISTORY at the client on the first tick — the
    // exact thing the contract says `subscribe` does not do. `subscribe` is
    // membership in the fan-out; `resume` is replay from a cursor. They are
    // separate frames precisely so that subscribing never implicitly replays,
    // and a defaulted cursor quietly reunited them.
    //
    // Leaving it undefined makes the invariant structural rather than
    // remembered: a connection becomes eligible for live delivery only once
    // something has established WHERE it starts — either `seed` at subscribe
    // time (the current high-water mark) or a `resume` carrying the client's
    // own cursor. Guessing zero is never the right answer to "I do not know
    // where this client is".
    if (since === undefined) return 0;

    const page = await deps.log.since(spaceId, since, batch, await deps.claimsFor(sink.identity));

    let delivered = 0;
    for (const event of page.items) {
      if (!sink.isOpen) break;
      delivered += deps.publisher.publishDurableTo(sink, event as DurableWorkspaceEvent).delivered;
    }

    // Advance past everything EXAMINED, not just everything delivered — the same
    // rule events.poll uses. A cursor that only advances past delivered rows
    // wedges forever on the first row this connection cannot see.
    const next = Number(page.nextCursor);
    if (Number.isSafeInteger(next) && next > since) bySpace.set(spaceId, next);
    return delivered;
  }

  return {
    async tick(): Promise<number> {
      // Re-entrancy guard: a slow tick must not overlap the next one and
      // deliver the same page twice.
      if (running) return 0;
      running = true;
      let delivered = 0;
      try {
        for (const sink of deps.registry.sinks()) {
          if (!sink.isOpen) {
            cursors.delete(sink.id);
            continue;
          }
          for (const spaceId of deps.registry.spacesFor(sink.id)) {
            try {
              delivered += await pumpOne(sink, spaceId);
            } catch (error) {
              // One connection's failure must not stop the others.
              deps.onError?.(error instanceof Error ? error.message : String(error));
            }
          }
        }
      } finally {
        running = false;
      }
      return delivered;
    },

    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void this.tick();
      }, intervalMs);
      // Never hold the process open for a poller.
      timer.unref?.();
    },

    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },

    seed(connId: string, spaceId: string, seq: number): void {
      cursorsFor(connId).set(spaceId, seq);
    },

    forget(connId: string): void {
      cursors.delete(connId);
    },
  };
}
