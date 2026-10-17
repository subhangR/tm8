import type { Querier } from '../../../db/types.js';
import type { RequestContext } from '../../../http/types.js';

/**
 * "Made during a session" (Design Rules §2.3): `authored_from`, entity ->
 * work_session or chat, recorded by the SERVER from the caller's verified
 * bearer, never asserted by a client (308; it replaces the CLI's unverified
 * `created_in`). A worker's bearer names its work session; a chat's
 * `agent_runtime` bearer names its chat (327: before it, nothing a chat made
 * was linked to it). The RPC records only when that session or chat is live
 * and its teammate created the entity, so it is a no-op for a human caller,
 * a foreign entity, or an entity that already has one.
 */
export async function recordAuthoredFrom(q: Querier, ctx: RequestContext, entityId: string | undefined | null): Promise<void> {
  if (ctx.identity.kind !== 'bearer' || !entityId) return;
  const origin = ctx.identity.workSessionId ?? ctx.identity.runtimeChatId ?? null;
  if (!origin) return;
  await q.rpc('record_authored_from', [entityId, origin]);
}
