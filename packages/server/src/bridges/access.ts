/**
 * Bridges B1b-3 (BRIDGE-ENTITY-DESIGN §2.4, §2.7, D21, D23; migration 399):
 * who hears a bridged message, who answers it, and the handle a session posts
 * under. Access itself is space-wide and needs no door: any session in the
 * space reads (`bridges.log.read`) and posts; the only limits are the outbox's
 * hard checks (B1b-2).
 *
 * These are the server's calls; the router (B1b-2) and the command executor
 * (B1b-4) make them inside their own transactions. Delivery is the router's.
 */
import type { Querier } from '../db/types.js';

export type BridgeWakeReason = 'directed' | 'thread' | 'all';

/** A session a log message reaches, at most one row each (§2.7). */
export interface BridgeAudienceMember { sessionId: string; reason: BridgeWakeReason }

/**
 * The sessions a log message wakes. `directed` always: an @handle in the body,
 * a reply to a message the session posted, a message in its /work thread.
 * Un-directed messages reach only sessions listening at `thread` (in a thread
 * they posted in) or `all`; every other session counts it as unread.
 */
export async function bridgeAudience(q: Querier, bridgeId: string, messageId: string): Promise<BridgeAudienceMember[]> {
  const rows = await q.query<{ session_id: string; reason: BridgeWakeReason }>(
    'select session_id::text, reason from public.bridge_message_audience($1, $2)', [bridgeId, messageId]);
  return rows.map(r => ({ sessionId: r.session_id, reason: r.reason }));
}

/** The router names a message's answerer: the directed session, else the target chat; also a hand-over. */
export async function setBridgeAnswerer(q: Querier, messageId: string, answererId: string): Promise<void> {
  await q.rpc('set_bridge_answerer', [messageId, answererId]);
}

/** The answer is done (a chat's turn settled). The answerer's own reply settles it as well. */
export async function settleBridgeAnswer(q: Querier, messageId: string): Promise<boolean> {
  return q.rpc<boolean>('settle_bridge_answer', [messageId]);
}

/** True when a post replies to a bridged message its poster is the answerer of (the outbox's un-directed bucket). */
export async function bridgePostIsDirected(q: Querier, messageId: string): Promise<boolean> {
  return q.rpc<boolean>('bridge_post_is_directed', [messageId]);
}

export interface BridgePosterHandle { spaceId: string; handle: string; entityId: string; title: string | null }

/**
 * The session's one space handle, minted on its first post to any bridge (or
 * at /work request time), and this bridge recorded as one it appeared on.
 */
export async function bridgePosterHandle(q: Querier, bridgeId: string, sessionId: string): Promise<BridgePosterHandle> {
  const row = await q.rpc<{ spaceId: string; handle: string; entityId: string; title: string | null }>(
    'bridge_poster_handle', [bridgeId, sessionId]);
  return { spaceId: row.spaceId, handle: row.handle, entityId: row.entityId, title: row.title };
}

/**
 * `/tell <handle> <text>`: directs an inbound message to a live worker. The
 * message becomes the worker's origin (D30, '/tell') and the worker its
 * answerer. Null when the handle names no live worker. The router delivers it.
 */
export async function tellBridgeWorker(q: Querier, input: {
  bridgeId: string; messageId: string; handle: string; sender?: { memberId?: string; participant?: string };
}): Promise<string | null> {
  return q.rpc<string | null>('bridge_tell', [input.bridgeId, input.messageId, input.handle, JSON.stringify(input.sender ?? {})]);
}

/** The envelope's `<origin kind="bridge" …/>` facts for one delivery (§2.3). */
export interface BridgeOriginFacts {
  bridgeId: string;
  provider: string;
  conversation: string;
  participant: string;
  trust: 'linked' | 'asserted' | 'guest';
  externalMessageId: string;
  directed: boolean;
  /** Log messages since this session's cursor. */
  unread: number;
}

/**
 * The origin facts for delivering `messageId` (a log message, or its copy in
 * the target chat) to `sessionId`. Null when the message did not come from a
 * bridge.
 */
export async function bridgeOriginFacts(
  q: Querier, messageId: string, sessionId: string | null, directed: boolean,
): Promise<BridgeOriginFacts | null> {
  const [row] = await q.query<{ f: BridgeOriginFacts | null }>(
    'select public.bridge_origin_facts($1, $2, $3) as f', [messageId, sessionId, directed]);
  return row?.f ?? null;
}

/** Log messages after the session's read cursor (before its first read: since it started). */
export async function bridgeUnreadCount(q: Querier, bridgeId: string, sessionId: string): Promise<number> {
  return Number(await q.rpc<number>('bridge_unread_count', [bridgeId, sessionId]));
}
