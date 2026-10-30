/**
 * The bridgeRuntime doors (BRIDGE-ENTITY-DESIGN §2.5, §3.4, D35): the frames
 * the connector runtime POSTs to `/v2/bridge-runtime/<route>`.
 *
 * WHY THESE ARE NOT CATALOG OPERATIONS. The catalog describes what a tm8
 * client may ask this node to do. These are a sidecar's frames on loopback,
 * the `/v2/voice/webhook` shape, and their set is the runtime's protocol
 * (`@tm8/contract`'s RuntimeRoute), not §3.4's six names: `link-claim` is gone
 * (D37) and `auth`, `conversations`, `conversation-state` and `media` exist.
 *
 * WHO MAY CALL. A `bridge_runtime` session only, and that session nothing
 * else: the identity resolver admits the kind only when this route asks it to
 * (`context.bridgeRuntime`), and refuses it on every other route; this file
 * refuses every other kind; every SQL door re-checks the live session row.
 *
 * STATUS CODES. The runtime retries a 5xx (and no answer) and never a 4xx
 * (D35). A frame refused for its content (off the allowlist, an unknown
 * connection) answers 409, so it is not retried; the refusal is counted.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { CollabError } from '@tm8/contract';
import type { AuthFrame, HeartbeatFrame, HelloFrame, HelloReply, InboundFrame, RuntimeRoute, SentFrame, StateFrame } from '@tm8/contract';

import type { Db, DbClaims } from '../../db/types.js';
import { readJsonBody } from '../../http/body.js';
import { sendWireError } from '../../http/errors.js';
import type { IdentityResolver, RequestIdentity } from '../../http/types.js';
import type { BridgeCommandHook } from './command-hook.js';
import type { BridgeRuntimeHub } from './hub.js';

export const BRIDGE_RUNTIME_PATH_PREFIX = '/v2/bridge-runtime/';

const ROUTES: readonly RuntimeRoute[] = [
  'hello', 'state', 'auth', 'conversations', 'conversation-state', 'inbound', 'sent', 'heartbeat', 'media',
];

/** B1b-5's relay (packages/server/src/bridges/connection-auth.ts), kept structural here. */
export interface BridgeConnectionAuthPort {
  relay(frame: AuthFrame): boolean;
  settle(connectionId: string): void;
}

export interface BridgeRuntimeRouteOptions {
  readonly db: Db;
  readonly resolveIdentity: IdentityResolver;
  readonly disableAutoOwner: boolean;
  readonly hub: BridgeRuntimeHub;
  /** B1b-4's executor. Absent: nothing is a command. */
  readonly commands?: () => BridgeCommandHook | undefined;
  readonly connectionAuth?: BridgeConnectionAuthPort;
  /** Starts a queued chat turn (the orchestrator's wake). */
  readonly wakeChat?: (chatId: string, requesterIdentityId: string) => void;
  /** A media frame carries base64 bytes; everything else is small. */
  readonly maxBodyBytes?: number;
  readonly log?: (line: string) => void;
}

export type BridgeRuntimeRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  context: { requestId: string },
) => Promise<boolean>;

interface InboundResult {
  status: 'stored' | 'duplicate' | 'refused' | 'ignored';
  messageId?: string;
  command?: boolean;
  reason?: string;
  wakeChat?: { chatId: string; identityId: string } | null;
}

function claimsOf(identity: RequestIdentity, requestId: string): DbClaims {
  return {
    identityId: identity.identityId,
    authKind: 'bridge_runtime',
    authSessionId: identity.sessionId,
    nodeAdmin: false,
    requestId,
  };
}

function reply(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  if (body === undefined) {
    res.writeHead(status, { 'x-tm8-request-id': requestId });
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-tm8-request-id': requestId });
  res.end(JSON.stringify(body));
}

function object(value: unknown, route: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CollabError('invalid_input', `the ${route} frame must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function createBridgeRuntimeRoute(o: BridgeRuntimeRouteOptions): BridgeRuntimeRoute {
  return async (req, res, { requestId }) => {
    const pathname = new URL(req.url ?? '/', 'http://tm8.invalid').pathname;
    if (req.method !== 'POST' || !pathname.startsWith(BRIDGE_RUNTIME_PATH_PREFIX)) return false;
    const route = pathname.slice(BRIDGE_RUNTIME_PATH_PREFIX.length) as RuntimeRoute;
    try {
      if (!ROUTES.includes(route)) throw new CollabError('not_found', `no bridge runtime route ${route}`);
      const identity = await o.resolveIdentity(req.headers, {
        remoteAddress: req.socket.remoteAddress,
        disableAutoOwner: o.disableAutoOwner,
        bridgeRuntime: true,
      });
      // Every other auth kind is refused here, the auto-owner included.
      if (identity.kind !== 'bearer' || identity.authKind !== 'bridge_runtime' || !identity.sessionId) {
        throw new CollabError('forbidden', 'only the bridge runtime may call the bridgeRuntime doors');
      }
      const { value } = await readJsonBody(req, o.maxBodyBytes ?? 32 * 1024 * 1024);
      const frame = object(value, route);
      const claims = claimsOf(identity, requestId);
      const answer = await handle(o, route, frame, claims);
      reply(res, answer.status, answer.body, requestId);
    } catch (err) {
      sendWireError(res, err, requestId);
    }
    return true;
  };
}

async function handle(
  o: BridgeRuntimeRouteOptions,
  route: RuntimeRoute,
  frame: Record<string, unknown>,
  claims: DbClaims,
): Promise<{ status: number; body?: unknown }> {
  switch (route) {
    case 'hello': {
      const hello = frame as unknown as HelloFrame;
      const raw = await o.db.rpc<{ connections: { connectionId: string; allowlist: HelloReply['connections'][number]['allowlist'] }[] }>(
        claims, 'bridge_runtime_hello', [JSON.stringify(hello)]);
      o.hub.noteHello(hello.runtimeId, hello.provider);
      const connections = await Promise.all(raw.connections.map(async (c) => ({
        connectionId: c.connectionId, stateKey: await o.hub.stateKey(c.connectionId), allowlist: c.allowlist,
      })));
      const body: HelloReply = { connections };
      return { status: 200, body };
    }
    case 'state': {
      const state = frame as unknown as StateFrame;
      const body = await o.db.rpc(claims, 'bridge_runtime_state', [JSON.stringify(state)]);
      if (state.status === 'linked' || state.status === 'logged_out') o.connectionAuth?.settle(state.connectionId);
      return { status: 200, body };
    }
    case 'auth': {
      // A QR or pairing code: relayed to the requesting member's stream only, and
      // never stored or logged here (§2.5, §7.3 item 8). The frame is not echoed.
      o.connectionAuth?.relay(frame as unknown as AuthFrame);
      return { status: 204 };
    }
    case 'conversations':
    case 'media': {
      o.hub.settleRequest(String(frame['requestId'] ?? ''), frame);
      return { status: 204 };
    }
    case 'conversation-state':
      return { status: 200, body: await o.db.rpc(claims, 'bridge_runtime_conversation_state', [JSON.stringify(frame)]) };
    case 'heartbeat': {
      const beat = frame as unknown as HeartbeatFrame;
      const body = await o.db.rpc(claims, 'bridge_runtime_heartbeat', [JSON.stringify(beat)]);
      o.hub.kick();
      return { status: 200, body };
    }
    case 'sent': {
      const body = await o.db.rpc(claims, 'bridge_runtime_sent', [JSON.stringify(frame as unknown as SentFrame)]);
      return { status: 200, body };
    }
    case 'inbound':
      return inbound(o, frame as unknown as InboundFrame, claims);
  }
}

/**
 * §2.3: detect a command inside the transaction (B1b-4's `detect` may read its
 * confirm table there), store, and after commit hand a command to the executor
 * or wake the chat a routed copy queued a turn on.
 */
async function inbound(
  o: BridgeRuntimeRouteOptions,
  frame: InboundFrame,
  claims: DbClaims,
): Promise<{ status: number; body: unknown }> {
  const hook = o.commands?.();
  const result = await o.db.tx(claims, async (q) => {
    let command = false;
    if (hook && frame.sender?.externalId && typeof frame.body === 'string' && frame.body.length > 0) {
      const bridgeId = await q.rpc<string | null>('bridge_runtime_bridge_for', [frame.connectionId, frame.conversationId]);
      if (bridgeId) {
        command = await hook.detect(frame.body, {
          q,
          bridgeId,
          senderExternalId: frame.sender.externalId,
          replyToExternalMessageId: frame.replyTo?.externalMessageId ?? null,
        });
      }
    }
    return q.rpc<InboundResult>('bridge_runtime_inbound', [JSON.stringify(frame), command]);
  });
  if (result.status === 'stored' && result.command && result.messageId && hook) {
    const messageId = result.messageId;
    void hook.run(messageId).catch((err) => o.log?.(`[bridges] command ${messageId} failed: ${(err as Error).message}`));
  }
  if (result.status === 'stored' && result.wakeChat) o.wakeChat?.(result.wakeChat.chatId, result.wakeChat.identityId);
  return { status: result.status === 'refused' ? 409 : 200, body: result };
}
