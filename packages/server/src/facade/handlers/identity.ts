/**
 * `identity.get` — the first operation that ever answered something other than
 * 501, and deliberately so: it exercises the whole vertical (loopback owner
 * bootstrap → claim binding → SECURITY DEFINER RPC → envelope) with the least
 * possible surface of its own. If this works, the plumbing works.
 */
import type {
  IdentityGetResult,
  IdentityProfileUpdateInput,
  IdentityProfileView,
  StylePrefsGetResult,
} from '@tm8/contract';

import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope } from '../context.js';

/** What `current_identity` returns; the server adds the node facts. */
type CurrentIdentityJson = Omit<IdentityGetResult, 'spaceSessions' | 'stylePrefs'>;

export function identityGet(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    // `current_identity` raises 28000 when the bound claim has no account row,
    // which is the honest answer to "who am I" from an unauthenticated caller —
    // so the check is the RPC's, not a second one here.
    const claims = claimsFor(owner, ctx);
    const identity = await deps.db.rpc<CurrentIdentityJson>(claims, 'current_identity');
    // The style preference rides along (styles spec §4.1) so the shell's boot
    // round trip already knows what to paint. Same claims, same identity.
    const { prefs } = await deps.db.rpc<StylePrefsGetResult>(claims, 'get_identity_style_prefs');
    // The node's space-sessions mode, so a client knows before its first
    // request whether a space pin is required (W3). Same default as config.
    const result: IdentityGetResult = {
      ...identity,
      spaceSessions: deps.config.spaceSessions ?? 'agents',
      stylePrefs: prefs,
    };
    return result;
  };
}

/**
 * `identity.profile.update` — the caller writes their OWN profile row.
 *
 * The subject is the bound identity claim and nothing else: the DTO has no
 * field naming whose profile to write, and the RPC derives the row key from
 * `internal.require_identity()`. No actor is bound — a profile belongs to an
 * identity, not to a per-space member (which is also why the DTO declares no
 * `actorId`).
 */
export function identityProfileUpdate(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const body = ctx.body as IdentityProfileUpdateInput;
    return deps.db.rpc<IdentityProfileView>(
      claimsFor(owner, ctx, { clientMutationId: envelope.clientMutationId }),
      'update_identity_profile',
      [
        body.displayName ?? null,
        body.avatar ?? null,
        body.email ?? null,
        body.globalId ?? null,
        envelope.clientMutationId ?? null,
      ],
    );
  };
}
