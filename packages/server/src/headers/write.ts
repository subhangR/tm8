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

import { AUTHORED_HEADER_LIMITS, HEADER_WHEN_TO_USE_BACKSTOP_CHARS, type HeaderTextInput, type ResultWarning } from '@tm8/contract';

import type { Querier } from '../db/types.js';
import type { RpcCommandResult } from '../facade/handlers/entities.js';

/** A header RPC's result: the command result, plus any advisory warnings. */
export type HeaderRpcResult = RpcCommandResult & { warnings?: ResultWarning[] };

/**
 * `header_long`: the header was written, and its whenToUse runs past the
 * 400-character guidance. Every later agent is shown a whenToUse WHOLE (task
 * 01a0da5a), so the write instructs instead of cutting or refusing. Null when
 * it fits, and when the RPC stored nothing (its own warning says why).
 */
export function headerLongWarning(text: HeaderTextInput, stored: HeaderRpcResult): ResultWarning | null {
  const chars = Array.from(text.whenToUse?.trim() ?? '').length;
  if (chars <= AUTHORED_HEADER_LIMITS.whenToUse) return null;
  if (headerWarnings(stored).some((w) => w.code === 'header_not_stored' || w.code === 'header_empty')) return null;
  return {
    code: 'header_long',
    message: `whenToUse is ${chars} characters and was written whole; every later agent reads it whole before `
      + `deciding to open this entity, so aim for one sentence under ${AUTHORED_HEADER_LIMITS.whenToUse} saying when to `
      + `open it${chars > HEADER_WHEN_TO_USE_BACKSTOP_CHARS ? ` (past ${HEADER_WHEN_TO_USE_BACKSTOP_CHARS} it is shown cut, declared in clipped)` : ''}`,
  };
}

/**
 * Write the whole header (absent fields are removed). `expectedVersion` is the
 * header's own version (0 = none yet); `undefined` writes unguarded. A long
 * whenToUse is written and warned about (`headerLongWarning`), never refused.
 */
export async function setEntityHeader(
  q: Querier,
  entityId: string,
  text: HeaderTextInput,
  expectedVersion: number | undefined,
  actorId: string | null,
  clientMutationId: string | null,
): Promise<HeaderRpcResult> {
  const raw = await q.rpc<HeaderRpcResult>('set_entity_header', [
    entityId, expectedVersion ?? null, actorId,
    text.whenToUse ?? null, text.summary ?? null, text.keywords ?? [],
    clientMutationId,
  ]);
  const long = headerLongWarning(text, raw);
  return long ? { ...raw, warnings: [...headerWarnings(raw), long] } : raw;
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
