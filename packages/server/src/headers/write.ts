/**
 * The two header doors (`entities.header.set` / `entities.header.clear`), as
 * the facade calls them. All checking lives in the SECURITY DEFINER RPCs of
 * migration 216 (kind allowlist, edit right, bounds, the header's own
 * version); this file only spells their argument lists once, so the create
 * paths (`entities.create`, `artifacts.create`) and the header operations
 * cannot drift apart.
 *
 * A header write never moves `entities.version`: it records an activity
 * (`fields:["header"]`) instead of an `entity.upsert`.
 */
import { createHash } from 'node:crypto';

import type { HeaderTextInput } from '@tm8/contract';

import type { Querier } from '../db/types.js';
import type { RpcCommandResult } from '../facade/handlers/entities.js';

/**
 * Write the whole header (absent fields are removed). `expectedVersion` is the
 * header's own version (0 = none yet); `undefined` writes unguarded.
 */
export function setEntityHeader(
  q: Querier,
  entityId: string,
  text: HeaderTextInput,
  expectedVersion: number | undefined,
  actorId: string | null,
  clientMutationId: string | null,
): Promise<RpcCommandResult> {
  return q.rpc<RpcCommandResult>('set_entity_header', [
    entityId, expectedVersion ?? null, actorId,
    text.whenToUse ?? null, text.summary ?? null, text.keywords ?? [],
    clientMutationId,
  ]);
}

/** Remove the authored header; the entity falls back to its native/derived one. */
export function clearEntityHeader(
  q: Querier,
  entityId: string,
  expectedVersion: number,
  actorId: string | null,
  clientMutationId: string | null,
): Promise<RpcCommandResult> {
  return q.rpc<RpcCommandResult>('clear_entity_header', [entityId, expectedVersion, actorId, clientMutationId]);
}

/**
 * The mutation id of a header written inside a create. One client mutation id
 * belongs to one operation (DEV-9), and the create's own id is already the
 * create's; a retried create replays both halves under their own ids.
 */
export function createHeaderMutationId(clientMutationId: string | null | undefined): string | null {
  if (!clientMutationId) return null;
  const derived = `${clientMutationId}:header`;
  // The ledger key is at most 200 characters (004); a long id still derives a
  // stable one.
  return derived.length <= 200
    ? derived
    : `header:${createHash('sha256').update(clientMutationId).digest('hex')}`;
}
