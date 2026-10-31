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
import { isHumanAuthKind } from '@tm8/contract';
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

  /**
   * Open sinks of ONE verified person, on human sockets only (an agent bearer
   * sharing the identity is never one). Not keyed by space or by connection
   * id: the identity is the only selector. `autoOwner` admits the node's own
   * loopback UI, whose sockets carry no identity id.
   */
  connectionsForIdentity(to: IdentityAddress): EventSink[] {
    const out: EventSink[] = [];
    for (const { sink } of this.byConnId.values()) {
      if (!sink.isOpen) continue;
      const identity = sink.identity;
      const mine = identity.kind === 'auto-owner'
        ? to.autoOwner === true
        : identity.kind === 'bearer' && identity.identityId !== undefined && identity.identityId === to.identityId
          && isHumanAuthKind(identity.authKind);
      if (mine) out.push(sink);
    }
    return out;
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

/** Who an identity-addressed frame is for: the verified identity, and whether that is the node's auto-owner. */
export interface IdentityAddress {
  readonly identityId: string;
  readonly autoOwner?: boolean;
}

/**
 * Identity-addressed EPHEMERAL fan-out (Bridges §2.5: a connection's QR or
 * pairing code). Structurally separate from both fan-outs above: no space, no
 * seq, never the durable log, so nothing it carries can be polled or replayed.
 */
export function fanOutToIdentity(registry: SubscriptionRegistry, to: IdentityAddress, text: string): number {
  let delivered = 0;
  for (const sink of registry.connectionsForIdentity(to)) {
    try {
      sink.send(text);
      delivered += 1;
    } catch {
      // See fanOutDurable.
    }
  }
  return delivered;
}

// `SubscriptionAuthorizer` USED TO BE DECLARED HERE, alongside an
// `AllowAllSubscriptionAuthorizer` that returned true unconditionally and whose
// own docstring said it "MUST NOT ship past W2". Both are gone, deliberately.
//
// The interface had ZERO call sites anywhere in the repository — it was a
// declared seam that nothing ever invoked, which is a comment rather than a
// defence, and the allow-all implementation was the only thing that satisfied
// it. Deleting the permissive implementation outright, rather than leaving it
// for a caller to pick up "temporarily", is the point: it cannot be wired in by
// accident if it does not exist.
//
// The live seam is now `SubscriptionAuthorizer` in control.ts, which is keyed
// on IDENTITY rather than connection id and IS invoked on every subscribe and
// every resume. Its production implementation, `DbSubscriptionAuthorizer`,
// answers from the same RLS predicate that guards `spaces.get`.
