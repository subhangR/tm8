/**
 * Bridges D22/D30/D31 (BRIDGE-ENTITY-DESIGN §2.8, migration 399): the doors
 * the server calls to give work its bridge provenance. The recorder itself is
 * SQL: an AFTER INSERT trigger on `public.entities` stamps every entity a
 * caller holding `bridgeOrigins` creates, in the create's own transaction, and
 * copies the origins into a spawned session's launch context (depth + 1).
 * These doors cover the moments an origin is BORN:
 *
 * - `recordBridgeOrigin` — the command or loop executor stamping an entity it
 *   created itself (`/task`), in that create's transaction;
 * - `SpawnServerFacts.bridgeOrigins` — a session launched for a bridge
 *   (`/work`, `bridges.work.start`, a loop); the spawn writes them with
 *   `public.bridge_launch_origins` in its own transaction;
 * - `addBridgeOrigin` — D30: a directed or routed message delivered to a
 *   running session, or starting a chat's turn;
 * - `clearBridgeOrigins` — a chat's turn settled (chat origins are
 *   turn-scoped; a session keeps its origins for life).
 *
 * The edge shape (D31): one `authored_from -> bridge` per (entity, bridge),
 * props `{bridgeId, origins[]}` with each origin
 * `{messageId, providerMessageId, sender, command, loopId?, inherited,
 * viaSessionId, depth}`, deduped on (bridgeId, providerMessageId); plus
 * `authored_from -> message` per (entity, origin message), props
 * `{bridgeId, origins: [that origin]}`.
 */
import type { BridgeOrigin } from '@tm8/execution';
import type { Querier } from '../db/types.js';

export type { BridgeOrigin } from '@tm8/execution';

/** One origin as it sits on a provenance edge. */
export interface BridgeEdgeOrigin extends BridgeOrigin {
  inherited: boolean;
  viaSessionId: string | null;
  depth: number;
}

/** props of an `authored_from` provenance edge (to the bridge or to the origin message). */
export interface BridgeProvenanceProps {
  bridgeId: string;
  origins: BridgeEdgeOrigin[];
}

const json = (origins: readonly BridgeOrigin[]): string => JSON.stringify(origins);

/**
 * Stamp an entity the executor created itself with the origin(s) that caused
 * it (`inherited: false`, depth 0). Call inside the create's transaction:
 * if the edge cannot be written this throws and the create fails. Idempotent.
 */
export async function recordBridgeOrigin(
  q: Querier, entityId: string, origin: BridgeOrigin | readonly BridgeOrigin[],
): Promise<number> {
  const origins = Array.isArray(origin) ? origin : [origin as BridgeOrigin];
  return q.rpc<number>('record_bridge_provenance', [entityId, json(origins)]);
}

/** D30: an origin reaches a running session or a chat's turn. False when it was already held. */
export async function addBridgeOrigin(q: Querier, holderId: string, origin: BridgeOrigin): Promise<boolean> {
  return q.rpc<boolean>('add_bridge_origin', [holderId, JSON.stringify(origin)]);
}

/** A chat's turn settled: its turn-scoped origins are dropped. */
export async function clearBridgeOrigins(q: Querier, chatId: string): Promise<number> {
  return q.rpc<number>('clear_bridge_origins', [chatId]);
}

/** The launch context, as the recorder will stamp it. */
export async function bridgeOriginsOf(q: Querier, holderId: string): Promise<BridgeEdgeOrigin[]> {
  const rows = await q.query<{
    bridge_id: string; message_id: string | null; provider_message_id: string | null;
    sender: BridgeOrigin['sender']; command: string | null; loop_id: string | null;
    inherited: boolean; via_session_id: string | null; depth: number;
  }>(
    `select bridge_id, message_id, provider_message_id, sender, command, loop_id, inherited, via_session_id, depth
       from public.session_bridge_origins where holder_id = $1
      order by added_at, bridge_id, origin_key`, [holderId]);
  return rows.map(r => ({
    bridgeId: r.bridge_id, messageId: r.message_id, providerMessageId: r.provider_message_id,
    sender: r.sender, command: r.command, ...(r.loop_id ? { loopId: r.loop_id } : {}),
    inherited: r.inherited, viaSessionId: r.via_session_id, depth: Number(r.depth),
  }));
}
