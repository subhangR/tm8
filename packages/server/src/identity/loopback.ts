/**
 * The v1 loopback auto-owner (T-L7 / S5, AM-4).
 *
 * WHY THIS FILE EXISTS RATHER THAN `IdentityServiceImpl` + `PgIdentityRepository`:
 * that pair is written against a schema that did not land. `PgIdentityRepository`
 * selects `login`, `node_admin` and `password_algo` (real columns: `username`,
 * `is_node_admin`, `password_algorithm`), calls jsonb-returning functions as if
 * they returned records, and passes `ensure_account` 7 arguments in the wrong
 * order when 007 declares 8. Every identity test that passes today runs against
 * the in-memory repository, so none of that has ever executed. Repairing it is
 * parked (Orion, post-Phase-1); this file is the narrow path the G1A loop
 * actually needs, bound to the RPCs as delivered.
 *
 * WHAT "AUTO-OWNER" IS NOT: a bypass. It bootstraps a real `accounts` row and
 * then every request runs with that row's real identity claim through the same
 * RLS as anything else. It is sound only because the node binds loopback (S1);
 * the moment that changes, this is replaced by the bearer path (S8), and those
 * are one change, not two.
 *
 * The two RPCs used here are claim-free, and both are claim-free for the same
 * reason: a caller who has not authenticated yet has no identity to bind.
 *   - `public.resolve_node_owner()` (142) — reads the single `is_owner` row by
 *     flag, so it finds the owner whatever its username is. This matters because
 *     `claim_node` (116) RENAMES the owner row's username from `owner` to the
 *     claimant's chosen handle: a read keyed on the literal `owner` misses on
 *     every CLAIMED node, falls through to `ensure_account`, and — since a
 *     claimed node has accounts — trips F1's node-admin demand at boot, killing
 *     the process before it listens. Reading by the flag is the fix, and it is
 *     mode-independent: nothing here decides who a NETWORK caller is (that is
 *     `disableAutoOwner`, which in multi mode narrows the loopback arm to
 *     anonymous BEFORE this resolver is reached — see http/identity-resolver.ts).
 *   - `public.ensure_account(...)` (F1) — creates the owner, but ONLY while the
 *     node has zero accounts; from the second account on it demands a node
 *     admin. Reached here exactly once per node, on the virgin first boot.
 */
import { CollabError } from '@tm8/contract';
import type { Db } from '../db/types.js';
import { randomUUID } from 'node:crypto';

/** The node owner, as the facade needs it. */
export interface LoopbackOwner {
  readonly identityId: string;
  readonly accountId: string;
  readonly username: string;
  readonly isNodeAdmin: boolean;
  readonly isOwner: boolean;
}

export const LOOPBACK_OWNER_USERNAME = 'owner';
export const LOOPBACK_OWNER_DISPLAY_NAME = 'Owner';

/** Shape of `resolve_account_credential` / `ensure_account`'s jsonb result. */
interface AccountJson {
  accountId?: string;
  id?: string;
  identityId?: string;
  identity_id?: string;
  username?: string;
  isOwner?: boolean;
  is_owner?: boolean;
  isNodeAdmin?: boolean;
  is_node_admin?: boolean;
  status?: string;
}

/**
 * The two RPCs disagree about casing — `resolve_account_credential` builds a
 * camelCase object by hand, `ensure_account` returns `to_jsonb(accounts)` which
 * is snake_case. Normalising here beats making callers know which one they got.
 */
function toOwner(row: AccountJson): LoopbackOwner {
  const identityId = row.identityId ?? row.identity_id;
  const accountId = row.accountId ?? row.id;
  if (!identityId || !accountId) {
    throw new CollabError('upstream_unavailable', 'owner account row is missing its identity');
  }
  return {
    identityId,
    accountId,
    username: row.username ?? LOOPBACK_OWNER_USERNAME,
    isNodeAdmin: row.isNodeAdmin ?? row.is_node_admin ?? false,
    isOwner: row.isOwner ?? row.is_owner ?? false,
  };
}

/**
 * Resolve (bootstrapping on first run) the node owner.
 *
 * Idempotent in both directions:
 * - on a virgin database the read misses and `ensure_account` mints the owner
 *   — the zero-accounts case F1 explicitly permits claim-free;
 * - on every later boot the read hits and `ensure_account` is never called, so
 *   F1's 28000 is never tripped and `UNIQUE(is_owner) WHERE is_owner` is never
 *   raced. We handle the single-owner rule rather than relying on it to fire.
 *
 * The read is keyed on the `is_owner` FLAG, not on the literal username `owner`,
 * so a CLAIMED node — whose owner row `claim_node` renamed to the claimant's
 * handle — resolves cleanly instead of missing the read and crashing into F1.
 * A lookup by a boolean column is unambiguous here for one reason: 002:65's
 * `UNIQUE(is_owner) WHERE is_owner` guarantees AT MOST ONE row has it set, so
 * "the is_owner row" is a single row, never a set.
 *
 * The `identity_id` is minted server-side and is permanent: rows across the
 * graph reference it by value, and 002 refuses to rewrite one.
 */
export async function resolveLoopbackOwner(db: Db): Promise<LoopbackOwner> {
  // Claim-free by design. No identity is bound because we are in the middle of
  // working out what the identity IS. Reads the single is_owner row by flag, so
  // it finds the owner whatever its username has been claimed to.
  const existing = await db.rpc<AccountJson | null>({}, 'resolve_node_owner', []);
  if (existing) return toOwner(existing);

  const created = await db.rpc<AccountJson | null>({}, 'ensure_account', [
    `id_${randomUUID()}`,
    LOOPBACK_OWNER_USERNAME,
    LOOPBACK_OWNER_DISPLAY_NAME,
    null, // email
    true, // p_is_owner
    true, // p_is_node_admin
    null, // password_algorithm — a loopback-only node may have no password (S1+S5)
    null, // password_hash
  ]);
  if (!created) {
    throw new CollabError('upstream_unavailable', 'ensure_account returned no row');
  }
  return toOwner(created);
}

/**
 * Process-lifetime memo around `resolveLoopbackOwner`.
 *
 * The owner is resolved once and reused: it cannot change without a restart
 * (identity_id is immutable, and there is exactly one owner per node), and
 * doing this per request would put two extra round trips in front of every
 * single operation.
 *
 * The in-flight promise is cached, not just the result, so N concurrent
 * first-requests bootstrap once instead of racing N `ensure_account` calls into
 * the single-owner index. A failure clears the cache so the next request
 * retries rather than inheriting a permanent error.
 */
export function createLoopbackOwnerResolver(db: Db): () => Promise<LoopbackOwner> {
  let pending: Promise<LoopbackOwner> | undefined;
  return () => {
    if (!pending) {
      pending = resolveLoopbackOwner(db).catch((err: unknown) => {
        pending = undefined;
        throw err;
      });
    }
    return pending;
  };
}
