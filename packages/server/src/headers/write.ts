/**
 * The two header doors (`entities.header.set` / `entities.header.clear`), as
 * the facade calls them. All checking lives in the SECURITY DEFINER RPCs of
 * migrations 216/223 (edit right, the header's own version); content is never
 * refused, only normalised, and a kind that stores no header comes back as a
 * no-op with a warning. This file only spells their argument lists once, so
 * the create paths (`entities.create`, `artifacts.create`, `artifacts.publish`)
 * and the header operations cannot drift apart.
 *
 * A header write never moves `entities.version`: it records an activity
 * (`fields:["header"]`) instead of an `entity.upsert`.
 */
import { createHash } from 'node:crypto';

import type { HeaderTextInput, ResultWarning } from '@tm8/contract';

import type { Querier } from '../db/types.js';
import type { RpcCommandResult } from '../facade/handlers/entities.js';

/** A header RPC's result: the command result, plus any advisory warnings. */
export type HeaderRpcResult = RpcCommandResult & { warnings?: ResultWarning[] };

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
): Promise<HeaderRpcResult> {
  return q.rpc<HeaderRpcResult>('set_entity_header', [
    entityId, expectedVersion ?? null, actorId,
    text.whenToUse ?? null, text.summary ?? null, text.keywords ?? [],
    clientMutationId,
  ]);
}

/**
 * Remove the authored header; the entity falls back to its native/derived one.
 * `undefined` clears unguarded; no header is a no-op with a warning.
 */
export function clearEntityHeader(
  q: Querier,
  entityId: string,
  expectedVersion: number | undefined,
  actorId: string | null,
  clientMutationId: string | null,
): Promise<HeaderRpcResult> {
  return q.rpc<HeaderRpcResult>('clear_entity_header', [entityId, expectedVersion ?? null, actorId, clientMutationId]);
}

/**
 * A create's result with the header write's warnings appended, whichever shape
 * it took (a `CommandResult` or a server receipt, whose `warnings` the CLI
 * prints verbatim).
 */
export function withHeaderWarnings<T extends object>(result: T, warnings: readonly ResultWarning[]): T {
  if (warnings.length === 0) return result;
  const prior = (result as { warnings?: unknown }).warnings;
  return { ...result, warnings: [...(Array.isArray(prior) ? prior : []), ...warnings] };
}

/** The warnings a header RPC returned; empty when it had nothing to say. */
export function headerWarnings(raw: HeaderRpcResult | undefined): ResultWarning[] {
  return Array.isArray(raw?.warnings) ? raw.warnings : [];
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
