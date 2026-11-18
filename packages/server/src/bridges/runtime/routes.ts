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
import { pipeline } from 'node:stream/promises';
import type { W2BlobStore } from '../../files/w2-blob-store.js';

import { CollabError } from '@tm8/contract';
import type { AuthFrame, HeartbeatFrame, HelloFrame, HelloReply, InboundFrame, RuntimeRoute, SentFrame, StateFrame } from '@tm8/contract';

import type { Db, DbClaims } from '../../db/types.js';
import { readJsonBody } from '../../http/body.js';
import { sendWireError } from '../../http/errors.js';
import type { IdentityResolver, RequestIdentity } from '../../http/types.js';
import type { BridgeCommandHook } from './command-hook.js';
import type { BridgeRuntimeHub } from './hub.js';

export const BRIDGE_RUNTIME_PATH_PREFIX = '/v2/bridge-runtime/';
/**
 * The longest a message with media waits for its files and voice-note
 * transcripts before it is delivered without them (442 §3). A late file is
 * still attached to the message and its copies when it arrives.
 */
const MEDIA_SETTLE_MS = 180_000;

const ROUTES: readonly RuntimeRoute[] = [
  'hello', 'state', 'auth', 'conversations', 'conversation-state', 'inbound', 'sent', 'heartbeat', 'media', 'group', 'outbound-progress',
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
  readonly blobStore?: Pick<W2BlobStore, 'openRead'>;
  /** B1b-4's executor. Absent: nothing is a command. */
  readonly commands?: () => BridgeCommandHook | undefined;
  readonly connectionAuth?: BridgeConnectionAuthPort;
  /** Delivers a stored inbound message to its session target and its directed workers (413 §5). */
  readonly deliver?: (messageId: string) => Promise<unknown>;
  /**
   * R11 (425): resumes, else replaces, a bridge's session target that is not
   * running, before the message is delivered to it. Absent: delivered as is.
   */
  readonly keepSession?: (bridgeId: string, messageId: string) => Promise<unknown>;
  /**
   * Fetches inbound media into file entities after commit (413 §4). With
   * `settle` (442 §3) a message with media is delivered, and its chat woken,
   * once its files are attached and its voice notes transcribed (bounded).
   */
  readonly media?: { kick(): Promise<number>; settle?(messageId: string, timeoutMs: number): Promise<void> };
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
  bridgeId?: string;
  /** 425: a routed copy for a session target, and whether that session is running. */
  targetSession?: { sessionId: string; live: boolean } | null;
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
    const route = pathname.slice(BRIDGE_RUNTIME_PATH_PREFIX.length) as RuntimeRoute | 'outbound-media';
    try {
      if (route !== 'outbound-media' && !ROUTES.includes(route)) throw new CollabError('not_found', `no bridge runtime route ${route}`);
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
      if (route === 'outbound-media') {
        const file = await o.db.rpc<{ storagePath: string; spaceId: string }>(claims,
          'bridge_runtime_outbound_media', [frame['outboxId'], frame['connectionId'], frame['fileEntityId']]);
        if (!o.blobStore) throw new CollabError('upstream_unavailable', 'attachment storage is unavailable');
        const blob = await o.blobStore.openRead(file.storagePath, file.spaceId);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': blob.sizeBytes,
          'cache-control': 'no-store', 'x-tm8-request-id': requestId });
        await pipeline(blob.stream, res);
        return true;
      }
      const answer = await handle(o, route, frame, claims);
      reply(res, answer.status, answer.body, requestId);
    } catch (err) {
      if (res.headersSent) res.destroy(err as Error);
      else sendWireError(res, err, requestId);
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
      o.hub.noteHello(hello.runtimeId, hello.provider, hello.version, hello.capabilities);
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
    case 'media':
    case 'group': {
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
    case 'outbound-progress':
      return { status: 200, body: await o.db.rpc(claims, 'bridge_runtime_outbound_progress', [JSON.stringify(frame)]) };
    case 'sent': {
      const body = await o.db.rpc(claims, 'bridge_runtime_sent', [JSON.stringify(frame as unknown as SentFrame)]);
      o.hub.kick();
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
  // v4: an edit or a delete at the provider changes the stored copies (443 §5)
  // and is never a new turn: no command, no routing, no wake, no delivery.
  if ((frame.edit !== undefined && frame.edit !== null) || frame.deleted === true) {
    const changed = await o.db.rpc<InboundResult>(claims, 'bridge_runtime_inbound_change', [JSON.stringify(frame)]);
    return { status: changed.status === 'refused' ? 409 : 200, body: changed };
  }
  // v4: the sender's provider email links them to a member (443 §4) in this
  // transaction, before the message is stored and its author resolved. The
  // email goes to that check only: it is not in the frame the message is
  // stored from.
  const email = typeof frame.sender?.email === 'string' && frame.sender.email.length > 0 ? frame.sender.email : null;
  const stored: InboundFrame = frame.sender && 'email' in frame.sender
    ? { ...frame, sender: { ...frame.sender, email: null } } : frame;
  const hook = o.commands?.();
  const result = await o.db.tx(claims, async (q) => {
    if (email) await q.rpc('bridge_runtime_sender_email', [JSON.stringify(frame)]);
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
    return q.rpc<InboundResult>('bridge_runtime_inbound', [JSON.stringify(stored), command]);
  });
  if (result.status === 'stored' && result.command && result.messageId && hook) {
    const messageId = result.messageId;
    void hook.run(messageId).catch((err) => o.log?.(`[bridges] command ${messageId} failed: ${(err as Error).message}`));
  }
  // 442 §3: a message with media reaches its readers once its files are
  // attached and its voice notes transcribed, so the photo and the words are
  // in what they read. Bounded by MEDIA_SETTLE_MS; the HTTP answer never waits.
  const withMedia = result.status === 'stored' && Array.isArray(frame.media) && frame.media.length > 0;
  let settled: Promise<void> = Promise.resolve();
  if (withMedia && o.media?.settle && result.messageId) settled = o.media.settle(result.messageId, MEDIA_SETTLE_MS);
  else if (withMedia) void o.media?.kick();
  if (result.status === 'stored' && result.wakeChat) {
    const wake = result.wakeChat;
    if (withMedia) void settled.then(() => o.wakeChat?.(wake.chatId, wake.identityId));
    else o.wakeChat?.(wake.chatId, wake.identityId);
  }
  if (result.status === 'stored' && !result.command && result.messageId && o.deliver) {
    const messageId = result.messageId;
    const deliver = o.deliver;
    // R11: a session that stopped is resumed (or replaced) first, so the copy
    // lands on a session that runs. The media settle meanwhile.
    const keep = result.targetSession && !result.targetSession.live && result.bridgeId && o.keepSession
      ? o.keepSession(result.bridgeId, messageId)
      : Promise.resolve();
    void Promise.all([
      keep.catch((err) => o.log?.(`[bridges] keeping the session of ${result.bridgeId} failed: ${(err as Error).message}`)),
      settled,
    ])
      .then(() => deliver(messageId))
      .catch((err) => o.log?.(`[bridges] delivery of ${messageId} failed: ${(err as Error).message}`));
  }
  return { status: result.status === 'refused' ? 409 : 200, body: result };
}
