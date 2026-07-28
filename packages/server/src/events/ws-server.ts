/**
 * The HTTP→WebSocket upgrade handler for `events.subscribe`.
 *
 * T-L10 / 04 §2.3: ONE socket carries the whole workspace event stream — there
 * is no per-space or per-entity socket, and this is the only upgrade path the
 * node exposes. The path comes from `getOperation('events.subscribe').path`
 * and is never written as a string literal, because the HTTP router is
 * catalog-generated and a hardcoded `/v2/ws` here would be a second source of
 * truth that silently drifts.
 *
 * NO LONGER A SKELETON. The handshake is real, and so is everything above it:
 * `@tm8/contract` now defines the client→server control frames, `control.ts`
 * applies them through an authorizer that is actually invoked, and `pump.ts`
 * publishes durable events to each connection under its own claims. This file
 * stays deliberately thin — it owns the upgrade and nothing else, and the
 * composition root wires the control channel in through `onClientMessage`.
 */
import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

import { getOperation } from '@tm8/contract';

import type { RequestIdentity } from '../http/types.js';
import { SubscriptionRegistry, fanOutDurable, fanOutPresence } from './subscriptions.js';
import { WsConnection, type EventSink, type WsSocket } from './ws-connection.js';
import { CLOSE_CODE } from './ws-frame.js';

/** RFC 6455 §1.3 — the fixed GUID mixed into `Sec-WebSocket-Accept`. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Catalog-derived. Do not inline. */
export const WS_PATH = getOperation('events.subscribe').path;

export interface WsServerOptions {
  /** Share the registry with the publisher; one is created if omitted. */
  registry?: SubscriptionRegistry;
  /**
   * AUTH SEAM. Resolves the caller from the upgrade request. Throwing refuses
   * the upgrade with a plain `401`. When absent the connection is accepted as
   * `{ kind: 'auto-owner' }` — v1 local mode auto-authenticates the owner
   * (T-L7 / S5) and the node binds loopback.
   */
  authorize?: (req: IncomingMessage) => RequestIdentity | Promise<RequestIdentity>;
  /** Forwarded to each connection; injectable so tests need not wait 30s. */
  heartbeatMs?: number;
  missedPongLimit?: number;
  /**
   * Raw client→server text frames.
   *
   * This used to be "the honest hole": the contract defined no client→server
   * message, and the previous author declined to invent one rather than put an
   * off-contract protocol on the socket. That refusal was correct and the hole
   * is now filled at the contract level — `WorkspaceControlFrame` exists, and
   * the composition root passes `createControlChannel(...).handle` here. The
   * hook stays a hook so this file still knows nothing about authorization.
   */
  onClientMessage?: (conn: EventSink, text: string) => void;
  /**
   * Called when a connection goes away, after it leaves the registry.
   *
   * Presence and the pump's per-connection cursors are keyed by connection id,
   * and both would otherwise leak: a viewer would linger after their tab closed
   * and a cursor map would grow without bound across a long-lived process.
   */
  onDisconnect?: (connId: string) => void;
  /** Called after a successful upgrade, before any frame is read. */
  onConnection?: (conn: EventSink) => void;
}

export interface WsServer {
  readonly registry: SubscriptionRegistry;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  /** Durable stream fan-out. Presence has its own path (DEV-4). */
  broadcast(spaceId: string, text: string): number;
  broadcastPresence(spaceId: string, text: string): number;
  connectionCount(): number;
  closeAll(code?: number, reason?: string): void;
}

/** `Sec-WebSocket-Accept` = base64(sha1(key + GUID)). */
export function computeAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function refuse(socket: Duplex, status: number, statusText: string, body: string): void {
  // Plain HTTP, not the DEV-8 JSON error envelope: the peer is still speaking
  // HTTP at this point and a failed upgrade never becomes a WebSocket, so
  // there is no socket to deliver a contract-shaped error over.
  // `end`, not `write` + `destroy`: destroying immediately after a write can
  // discard the unflushed response and leave the client with a bare RST.
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      'connection: close\r\n' +
      'content-type: text/plain; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (raw === undefined) return '';
  return Array.isArray(raw) ? (raw[0] ?? '') : raw;
}

export function createWsServer(opts: WsServerOptions = {}): WsServer {
  const registry = opts.registry ?? new SubscriptionRegistry();

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://tm8.invalid').pathname;
    if (path !== WS_PATH) {
      refuse(socket, 400, 'Bad Request', `no websocket operation bound to ${path}`);
      return;
    }

    if (headerValue(req, 'upgrade').toLowerCase() !== 'websocket') {
      refuse(socket, 400, 'Bad Request', 'expected Upgrade: websocket');
      return;
    }
    if (headerValue(req, 'sec-websocket-version') !== '13') {
      refuse(socket, 400, 'Bad Request', 'only Sec-WebSocket-Version: 13 is supported');
      return;
    }
    const key = headerValue(req, 'sec-websocket-key');
    if (key === '') {
      refuse(socket, 400, 'Bad Request', 'missing Sec-WebSocket-Key');
      return;
    }

    // NOTE: Origin and Host checks are DELIBERATELY NOT HERE. Per the CTO's
    // scope trim they land in http/security.ts post-G1A and are applied to
    // every request including this upgrade — a WebSocket-only origin check
    // would be a second, divergent policy. This comment marks the call point.

    let identity: RequestIdentity;
    try {
      identity = opts.authorize === undefined ? { kind: 'auto-owner' } : await opts.authorize(req);
    } catch {
      refuse(socket, 401, 'Unauthorized', 'websocket upgrade refused');
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${computeAcceptKey(key)}\r\n\r\n`,
    );

    const wsSocket: WsSocket = socket;
    const conn = new WsConnection(wsSocket, identity, {
      ...(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs }),
      ...(opts.missedPongLimit === undefined ? {} : { missedPongLimit: opts.missedPongLimit }),
    });

    registry.add(conn);
    conn.onClose(() => {
      registry.remove(conn.id);
      opts.onDisconnect?.(conn.id);
    });
    if (opts.onClientMessage !== undefined) {
      const handler = opts.onClientMessage;
      conn.onMessage((text) => handler(conn, text));
    }
    opts.onConnection?.(conn);

    // Bytes the HTTP parser had already buffered past the request headers.
    if (head.length > 0) conn.ingest(head);
  }

  return {
    registry,
    handleUpgrade,
    broadcast: (spaceId, text) => fanOutDurable(registry, spaceId, text),
    broadcastPresence: (spaceId, text) => fanOutPresence(registry, spaceId, text),
    connectionCount: () => registry.size(),
    closeAll: (code = CLOSE_CODE.goingAway, reason = 'server shutting down') => {
      for (const sink of registry.sinks()) sink.close(code, reason);
    },
  };
}
