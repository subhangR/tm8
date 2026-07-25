/**
 * Who receives what.
 *
 * DEV-4 is encoded here STRUCTURALLY rather than as a runtime check: presence
 * and typing events are ephemeral and never ride the durable stream, so there
 * are two fan-out functions over two lookups — `fanOutDurable` /
 * `connectionsFor`, and `fanOutPresence` / `presenceConnectionsFor`. There is
 * deliberately no single `fanOut(spaceId, event, isPresence)` with a branch
 * inside it, because a branch is one bad `if` away from leaking a presence
 * event onto the durable stream and poisoning a client's `seq` cursor. Two
 * paths cannot make that mistake.
 *
 * The registry holds `EventSink`s, not sockets — it has no idea WebSocket
 * exists (T-L10: one socket, but the fan-out must not care what the socket is).
 */
import type { EventSink } from './ws-connection.js';

interface SubscriptionState {
  readonly sink: EventSink;
  /** Spaces whose DURABLE events this connection wants. */
  readonly spaces: Set<string>;
  /** Opt-in to the ephemeral presence channel (DEV-4). Off by default. */
  presence: boolean;
}

export class SubscriptionRegistry {
  private readonly byConnId = new Map<string, SubscriptionState>();
  /** spaceId → connIds. Reverse index so fan-out is not an O(connections) scan. */
  private readonly bySpace = new Map<string, Set<string>>();

  add(sink: EventSink): void {
    if (this.byConnId.has(sink.id)) return;
    this.byConnId.set(sink.id, { sink, spaces: new Set(), presence: false });
  }

  remove(connId: string): void {
    const state = this.byConnId.get(connId);
    if (state === undefined) return;
    for (const spaceId of state.spaces) this.detach(connId, spaceId);
    this.byConnId.delete(connId);
  }

  subscribe(connId: string, spaceId: string): void {
    const state = this.byConnId.get(connId);
    if (state === undefined) return;
    state.spaces.add(spaceId);
    let members = this.bySpace.get(spaceId);
    if (members === undefined) {
      members = new Set();
      this.bySpace.set(spaceId, members);
    }
    members.add(connId);
  }

  unsubscribe(connId: string, spaceId: string): void {
    const state = this.byConnId.get(connId);
    if (state === undefined) return;
    state.spaces.delete(spaceId);
    this.detach(connId, spaceId);
  }

  /**
   * Toggle the presence channel. Note this is a per-CONNECTION flag, not a
   * per-space one: a connection that wants presence gets it for the spaces it
   * is already subscribed to and no others — presence is never a way to
   * observe a space you cannot otherwise read.
   */
  subscribePresence(connId: string, on: boolean): void {
    const state = this.byConnId.get(connId);
    if (state === undefined) return;
    state.presence = on;
  }

  /** Durable stream recipients for a space. */
  connectionsFor(spaceId: string): EventSink[] {
    const members = this.bySpace.get(spaceId);
    if (members === undefined) return [];
    const out: EventSink[] = [];
    for (const connId of members) {
      const state = this.byConnId.get(connId);
      if (state !== undefined && state.sink.isOpen) out.push(state.sink);
    }
    return out;
  }

  /** Ephemeral presence-channel recipients for a space (DEV-4). */
  presenceConnectionsFor(spaceId: string): EventSink[] {
    const members = this.bySpace.get(spaceId);
    if (members === undefined) return [];
    const out: EventSink[] = [];
    for (const connId of members) {
      const state = this.byConnId.get(connId);
      if (state !== undefined && state.presence && state.sink.isOpen) out.push(state.sink);
    }
    return out;
  }

  spacesFor(connId: string): string[] {
    const state = this.byConnId.get(connId);
    return state === undefined ? [] : [...state.spaces];
  }

  has(connId: string): boolean {
    return this.byConnId.has(connId);
  }

  /** Number of registered connections (not subscriptions). */
  size(): number {
    return this.byConnId.size;
  }

  /** Every registered sink, for shutdown. */
  sinks(): EventSink[] {
    return [...this.byConnId.values()].map((s) => s.sink);
  }

  private detach(connId: string, spaceId: string): void {
    const members = this.bySpace.get(spaceId);
    if (members === undefined) return;
    members.delete(connId);
    if (members.size === 0) this.bySpace.delete(spaceId);
  }
}

/**
 * Durable fan-out. Returns the number of sinks written to.
 *
 * A failed write to one sink must not stop the others — a wedged socket is a
 * transport problem, not a reason to drop an event for everyone else.
 */
export function fanOutDurable(registry: SubscriptionRegistry, spaceId: string, text: string): number {
  let delivered = 0;
  for (const sink of registry.connectionsFor(spaceId)) {
    try {
      sink.send(text);
      delivered += 1;
    } catch {
      // Ignored on purpose: the connection's own close path evicts it.
    }
  }
  return delivered;
}

/** Ephemeral presence fan-out. Structurally separate from `fanOutDurable`. */
export function fanOutPresence(registry: SubscriptionRegistry, spaceId: string, text: string): number {
  let delivered = 0;
  for (const sink of registry.presenceConnectionsFor(spaceId)) {
    try {
      sink.send(text);
      delivered += 1;
    } catch {
      // See fanOutDurable.
    }
  }
  return delivered;
}

/**
 * SEAM: who may subscribe to a space.
 *
 * The skeleton has no membership table, so it cannot answer this honestly.
 * At W2 this is a `space_members` lookup under the caller's identity (the same
 * RLS predicate that guards `spaces.get`) — subscription must not be a side
 * channel around read authorization. Declared here so the check has a home to
 * land in rather than being retrofitted into ws-server.
 */
export interface SubscriptionAuthorizer {
  canSubscribe(connId: string, spaceId: string): boolean | Promise<boolean>;
}

/**
 * Skeleton authorizer. Allows everything, because the skeleton binds loopback
 * and auto-authenticates the owner (T-L7 / S5). It MUST NOT ship past W2.
 */
export class AllowAllSubscriptionAuthorizer implements SubscriptionAuthorizer {
  canSubscribe(): boolean {
    return true;
  }
}
