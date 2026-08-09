/**
 * Turning an HTTP request into a database transaction's claims.
 *
 * One rule dominates this file, and it is the least obvious thing in the lane:
 *
 *   **`tm8.actor_id` is bound ONLY when the caller explicitly asked for an
 *   actor.**
 *
 * It is tempting to resolve the caller's member row once at auth time and bind
 * it on every transaction. That is wrong, and it fails in a way that looks like
 * an authorization bug. `internal.resolve_actor` (002:277) is
 *
 *     coalesce(requested, internal.actor_id(), internal.current_member_id(space))
 *
 * followed by a `can_act_as(actor, space)` check. A member row belongs to ONE
 * space. So a globally-bound actor from space A, used on a request touching
 * space B, fails `can_act_as` and raises 42501 — "not permitted to act as this
 * actor" — for the space's own owner. Leaving it unset lets the database pick
 * the correct per-space member row itself, which is exactly what
 * `current_member_id` is for.
 *
 * So: identity is global and always bound; the actor is per-space and left to
 * the database unless a `CommandContext.actorId` names one deliberately (the
 * acting-as case, which `can_act_as` then authorizes properly).
 */
import { CollabError } from '@tm8/contract';
import type { DbClaims } from '../db/types.js';
import type { LoopbackOwner } from '../identity/loopback.js';
import type { RequestContext } from '../http/types.js';

/** The command envelope every mutation carries (contract §4 preamble). */
export interface CommandEnvelope {
  actorId?: string;
  clientMutationId?: string;
  workSessionId?: string;
}

export function commandEnvelope(ctx: RequestContext): CommandEnvelope {
  const body = ctx.body;
  if (typeof body !== 'object' || body === null) return {};
  const { actorId, clientMutationId, workSessionId } = body as CommandEnvelope;
  return {
    ...(typeof actorId === 'string' ? { actorId } : {}),
    ...(typeof clientMutationId === 'string' ? { clientMutationId } : {}),
    ...(typeof workSessionId === 'string' ? { workSessionId } : {}),
  };
}

/**
 * Build the claims for one request.
 *
 * `requestId` is bound so an audit row and the id the client was handed are
 * joinable after the fact — the whole point of threading it this far down.
 *
 * BEARER (Identity v2 Stage 1): when the resolver verified a `tm8s_…` token,
 * `ctx.identity` carries the session's identity and it — not the memoised
 * node owner — is who this request runs as. The owner parameter remains the
 * auto-owner (loopback) source, exactly as before; doc 3 §3 named this line
 * as where the two would first differ. A bearer identity that somehow lacks
 * an id is refused rather than silently escalated to the owner.
 *
 * A persona-bound bearer owns its actor choice. Letting a request-body actor
 * override that binding would turn a session token into a general impersonation
 * credential before SQL gets a chance to check provenance. Human/CLI bearers
 * without a persona binding may still request an actor and SQL authorises it.
 */
export function claimsFor(
  owner: LoopbackOwner,
  ctx: RequestContext,
  envelope: CommandEnvelope = {},
): DbClaims {
  if (ctx.identity?.kind === 'anonymous') {
    throw new CollabError('unauthenticated', 'authentication is required');
  }
  const bearer = ctx.identity?.kind === 'bearer' ? ctx.identity : undefined;
  if (bearer && !bearer.identityId) {
    throw new CollabError('unauthenticated', 'bearer identity is unresolved');
  }
  if (bearer?.actorId && envelope.actorId && envelope.actorId !== bearer.actorId) {
    throw new CollabError('forbidden', 'a session-bound credential cannot override its actor');
  }
  const actorId = bearer?.actorId ?? envelope.actorId;
  return {
    identityId: bearer ? bearer.identityId! : owner.identityId,
    // See the file header: unset unless explicitly requested.
    ...(actorId ? { actorId } : {}),
    nodeAdmin: bearer ? bearer.nodeAdmin === true : owner.isNodeAdmin,
    requestId: ctx.requestId,
    // 083 / R11. FORWARDED, never defaulted. A request whose resolver did not
    // state a kind binds `''`, and `internal.require_human_auth_kind()` refuses
    // it — supplying a friendly default here would be exactly the `is null`
    // escape 083:133-138 warns against, moved one layer up where the migration
    // cannot see it.
    ...(ctx.identity?.authKind ? { authKind: ctx.identity.authKind } : {}),
  };
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/**
 * A path parameter, or `invalid_input`.
 *
 * The router only matches a path that HAS the segment, so an absent param is a
 * server bug (a handler bound to the wrong operation), not a client error —
 * but it still must not reach SQL as `undefined`.
 */
export function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (!value) {
    throw new CollabError('invalid_input', `missing path parameter :${name}`);
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids are uuids, and a non-uuid must be `not_found` rather than a 500.
 *
 * Without this, `where id = $1` with a malformed id raises SQLSTATE 22P02
 * (invalid_text_representation), which is not in the taxonomy table and would
 * surface as a 503 — telling the caller the database is unwell when in fact
 * they typed a bad id.
 */
export function requireUuidParam(ctx: RequestContext, name: string): string {
  const value = requireParam(ctx, name);
  if (!UUID_RE.test(value)) {
    throw new CollabError('not_found', `no such ${name}: ${value}`);
  }
  return value;
}

export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new CollabError('invalid_input', `${field} must be a uuid`);
  }
  return value;
}

/** `?limit=` with a sane ceiling — an unbounded page is a denial-of-service. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function limitOf(raw: string | number | undefined | null, fallback = DEFAULT_LIMIT): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CollabError('invalid_input', `limit must be a positive integer, got ${String(raw)}`);
  }
  return Math.min(n, MAX_LIMIT);
}
