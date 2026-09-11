/**
 * The raw WebSocket client for `events.subscribe` (LLD §6).
 *
 * This file knows the wire and nothing else: it opens one socket, encodes the
 * three control frames this client is allowed to send, and discriminates what
 * comes back. All policy — when to subscribe, when to resume, what a refusal
 * means, what to do when the socket dies — lives in `connection.ts`.
 *
 * THREE SERVER FACTS THIS FILE IS SHAPED BY (consensus-verified, LLD §6):
 *
 * 1. **There are no positive acks.** A successful `subscribe` or `resume` is
 *    answered with SILENCE. `control.refused` is the only ack that exists, so
 *    this file never waits for confirmation of anything and never exposes a
 *    promise that would imply one.
 * 2. **Control frames are parsed `.strict()`** (schemas.ts:751-764) — a single
 *    unknown key makes the whole frame malformed-refused. So frames are built
 *    literally here, from the `WorkspaceControlFrame` union, and never by
 *    spreading a caller's object.
 * 3. **Presence is dormant (R8).** There is deliberately no method to send a
 *    `presence` or `presence.set` frame — the absence is structural, not a
 *    comment someone can forget. Incoming presence/typing events are dropped
 *    here, before dispatch, so nothing downstream can ever see one.
 *
 * HEARTBEAT: passive, by design. The server sends WS-level pings every 30s and
 * evicts after two missed pongs (events/ws-connection.ts:60-61); the platform
 * answers them below this layer. This client sends no application heartbeat and
 * — importantly — must not read ping silence as liveness: a socket that has
 * gone quiet without closing is indistinguishable from a quiet workspace, which
 * is exactly why the connection state machine leans on `onclose`/`onerror` and
 * on the poll fallback rather than on a timer over inbound bytes.
 */
import {
  MAX_CONTROL_FRAME_SPACES,
  type DurableWorkspaceEvent,
  type LivenessChangedEvent,
  type SpaceId,
  type WorkspaceControlAck,
  type WorkspaceControlFrame,
} from '@tm8/contract';
import { isChatTurnFrame, type ChatTurnFrame } from '../../chat-home/types';

/** The one message field this client reads off an inbound event. */
export interface WebSocketMessage {
  data: unknown;
}

/**
 * The injectable socket. Deliberately the smallest surface that can carry the
 * protocol, so a fake in a test is a dozen lines and cannot accidentally reach
 * the network.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: WebSocketMessage) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** `WebSocket.OPEN`. Named rather than inlined so the fake reads the same. */
export const WS_OPEN = 1;

export interface SocketHandlers {
  /** The socket reached OPEN. Nothing has been subscribed yet. */
  onOpen(): void;
  /** A durable event arrived. Presence/typing/liveness never reach here (R8). */
  onEvent(event: DurableWorkspaceEvent): void;
  /**
   * The node's PTY map moved. EPHEMERAL: never advances the durable cursor,
   * never replayed on `resume`, and legal to drop — every one of these carries
   * the full live set for its space, so the next one repairs whatever the last
   * one missed. Optional, so a host that does not care simply does not wire it.
   */
  onLiveness?(event: LivenessChangedEvent): void;
  /** C3 rich-turn frame; not part of the durable workspace seq spine. */
  onChatTurn?(frame: ChatTurnFrame): void;
  /** THE only ack. Never silent — a refused space must not look like a quiet one. */
  onRefused(ack: WorkspaceControlAck): void;
  /** Socket closed or errored. Fires at most once per socket. */
  onClose(): void;
  /**
   * A frame that is neither an event nor an ack. Not fatal and not silent:
   * swallowing it would make a protocol drift look like an idle server.
   */
  onMalformed?(raw: unknown, cause?: unknown): void;
}

export interface SocketHandle {
  /** Add spaces to this connection's fan-out set. Chunked to the frame cap. */
  subscribe(spaceIds: SpaceId[]): void;
  unsubscribe(spaceIds: SpaceId[]): void;
  /** Replay `seq > since` for one space to this connection, then re-seed live delivery. */
  resume(spaceId: SpaceId, since: number): void;
  isOpen(): boolean;
  /** Idempotent. After this, no handler fires again for this socket. */
  close(): void;
}

/**
 * `spaceIds` is bounded at 100 per frame (contract.ts:380) and the frame is
 * parsed strict — an over-long list is refused WHOLE, taking every space in it
 * down with it. Chunking here means a 120-space client degrades to two frames
 * instead of to nothing.
 */
function chunk(ids: SpaceId[], size: number): SpaceId[][] {
  const out: SpaceId[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/**
 * Frame discrimination, in the order the protocol makes meaningful.
 *
 * The envelope check is the load-bearing one: `spaceId` + a finite numeric
 * `seq` is what makes a frame usable as a cursor at all, and a "durable event"
 * without a seq is not one — dispatching it would advance nothing and could
 * never be deduped. Rejecting it as malformed is the honest read.
 */
export type ParsedFrame =
  | { kind: 'event'; event: DurableWorkspaceEvent }
  | { kind: 'chat-turn'; frame: ChatTurnFrame }
  | { kind: 'refused'; ack: WorkspaceControlAck }
  | { kind: 'presence' }
  /**
   * `execution.liveness_changed` — ephemeral, and its own frame kind rather
   * than an `event`.
   *
   * THIS SPLIT IS THE WHOLE SAFETY PROPERTY. A durable event's `seq` advances
   * the client's per-space cursor (`connection.ts`'s dispatch), and this event
   * carries a CHANNEL-LOCAL seq from a different counter that resets on every
   * server restart (the server's `seq.ts`, S8). One ephemeral frame reaching
   * that cursor would move it to a number the durable log has not issued, and
   * every real event below it would then be silently dropped as "already
   * seen" — a client that stops updating and reports no error.
   *
   * So it never becomes a `DurableWorkspaceEvent` on this path at all. It is a
   * different kind, handled by a different handler, and there is no branch that
   * could route one into the other.
   */
  | { kind: 'liveness'; event: LivenessChangedEvent }
  | { kind: 'malformed'; reason: string };

export function parseFrame(raw: unknown): ParsedFrame {
  if (!isRecord(raw)) return { kind: 'malformed', reason: 'frame is not an object' };
  const type = raw.type;
  if (typeof type !== 'string') return { kind: 'malformed', reason: 'frame has no string type' };

  if (type === 'control.refused') {
    const frame = raw.frame;
    const reason = raw.reason;
    if (typeof frame !== 'string' || (reason !== 'forbidden' && reason !== 'malformed')) {
      return { kind: 'malformed', reason: 'control.refused missing frame/reason' };
    }
    const ack: WorkspaceControlAck = {
      type: 'control.refused',
      frame: frame as WorkspaceControlAck['frame'],
      reason,
      ...(typeof raw.spaceId === 'string' ? { spaceId: raw.spaceId } : {}),
    };
    return { kind: 'refused', ack };
  }

  // R8: dropped here so no consumer downstream can ever observe one. The
  // server does not put these on the durable stream today; this is the belt
  // beside that brace, and it is one line.
  if (type === 'presence.changed' || type === 'typing.changed') return { kind: 'presence' };

  /* Ephemeral liveness. Discriminated BEFORE the generic envelope check below,
     because it has a `spaceId` and a `seq` and would otherwise be waved through
     as a durable event — which is exactly the cursor poisoning the `liveness`
     frame kind exists to prevent. The fields are validated here rather than
     trusted: this is the untrusted wire, and a consumer that indexed into a
     missing `liveEntityIds` would throw inside a socket callback. */
  if (type === 'execution.liveness_changed') {
    if (typeof raw.spaceId !== 'string') {
      return { kind: 'malformed', reason: 'liveness event has no spaceId' };
    }
    if (typeof raw.nodeBootId !== 'string' || raw.nodeBootId === '') {
      return { kind: 'malformed', reason: 'liveness event has no nodeBootId' };
    }
    if (!Array.isArray(raw.liveEntityIds) || raw.liveEntityIds.some((id) => typeof id !== 'string')) {
      return { kind: 'malformed', reason: 'liveness event has no liveEntityIds' };
    }
    if (typeof raw.checkedAt !== 'string') {
      return { kind: 'malformed', reason: 'liveness event has no checkedAt' };
    }
    return { kind: 'liveness', event: raw as unknown as LivenessChangedEvent };
  }

  if (isChatTurnFrame(raw)) return { kind: 'chat-turn', frame: raw };

  if (typeof raw.spaceId !== 'string') return { kind: 'malformed', reason: 'event has no spaceId' };
  if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq)) {
    return { kind: 'malformed', reason: 'event has no finite seq' };
  }
  return { kind: 'event', event: raw as unknown as DurableWorkspaceEvent };
}

export function openSocket(
  url: string,
  factory: WebSocketFactory,
  handlers: SocketHandlers,
): SocketHandle {
  const ws = factory(url);
  let closed = false;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    handlers.onClose();
  };

  ws.onopen = () => {
    if (closed) return;
    handlers.onOpen();
  };

  ws.onmessage = (ev) => {
    if (closed) return;
    let parsed: unknown;
    try {
      parsed = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    } catch (cause) {
      handlers.onMalformed?.(ev.data, cause);
      return;
    }
    const frame = parseFrame(parsed);
    switch (frame.kind) {
      case 'event': handlers.onEvent(frame.event); return;
      case 'chat-turn': handlers.onChatTurn?.(frame.frame); return;
      case 'refused': handlers.onRefused(frame.ack); return;
      case 'liveness': handlers.onLiveness?.(frame.event); return;
      case 'presence': return;
      case 'malformed': handlers.onMalformed?.(parsed, frame.reason); return;
    }
  };

  ws.onerror = finish;
  ws.onclose = finish;

  const send = (frame: WorkspaceControlFrame): void => {
    if (closed || ws.readyState !== WS_OPEN) return;
    ws.send(JSON.stringify(frame));
  };

  return {
    subscribe(spaceIds) {
      for (const ids of chunk(spaceIds, MAX_CONTROL_FRAME_SPACES)) {
        if (ids.length > 0) send({ type: 'subscribe', spaceIds: ids });
      }
    },
    unsubscribe(spaceIds) {
      for (const ids of chunk(spaceIds, MAX_CONTROL_FRAME_SPACES)) {
        if (ids.length > 0) send({ type: 'unsubscribe', spaceIds: ids });
      }
    },
    resume(spaceId, since) {
      send({ type: 'resume', spaceId, since });
    },
    isOpen() {
      return !closed && ws.readyState === WS_OPEN;
    },
    close() {
      if (closed) return;
      closed = true;
      // Handlers are silenced BEFORE close() so a synchronous onclose from the
      // platform cannot re-enter as an unexpected disconnect.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    },
  };
}

/**
 * Adapter for a real browser `WebSocket`. NOTHING in this lane calls it —
 * `createRealSeam()` requires the factory to be supplied — so `src/data/real`
 * cannot open a socket unless an integration caller hands it this. The single
 * cast is the one point where the platform's DOM type meets ours; keeping it
 * here means the rest of the file stays strictly typed.
 */
export function browserWebSocketFactory(ctor: typeof WebSocket): WebSocketFactory {
  return (url: string) => new ctor(url) as unknown as WebSocketLike;
}
