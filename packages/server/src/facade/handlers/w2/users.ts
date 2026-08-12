/**
 * users.* — the control plane's HTTP seam.
 *
 * Thin, for the same reason `auth.ts` is thin: every authorization decision
 * lives in migration 101's SECURITY DEFINER doors, under the CALLER's claims.
 * `require_capability('users.provision')` refuses in SQL; these handlers bind
 * claims and translate shapes, and there is no branch here that could disagree
 * with the database about who may do what.
 *
 * WHAT MAKES `users.create` DIFFERENT FROM `auth.signup`. Signup wrote an
 * account and stopped — no space, no member row — so the person it created
 * logged in and was told the node had no spaces. That is not a hypothetical:
 * `ramu` on the production node has been in exactly that state since the
 * account was made. `users.create` provisions the whole user, and `auth.signup`
 * is now an alias over it, so the two cannot drift into two different notions
 * of what a user is.
 */
import type {
  AuthSignupResult, UserCapabilityInput, UsersCreateInput, UsersCreateResult, UsersListResult,
} from '@tm8/contract';
import { CollabError } from '@tm8/contract';

import type { OperationHandler } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor } from '../../context.js';
import {
  grantCapability,
  listProvisionedUsers,
  provisionUser,
  resolveHomesRoot,
  revokeCapability,
} from '../../../control-plane/provisioner.js';

/** The shared provisioning call — one path, two operations on top of it. */
async function provision(
  deps: FacadeDeps,
  ctx: Parameters<OperationHandler>[0],
  body: UsersCreateInput,
): Promise<UsersCreateResult> {
  const owner = await deps.owner();
  return provisionUser(
    deps.db,
    claimsFor(owner, ctx),
    {
      username: body.username,
      password: body.password,
      displayName: body.displayName ?? null,
      email: body.email ?? null,
      requestKey: body.requestKey ?? null,
    },
    resolveHomesRoot(),
  );
}

function usersCreate(deps: FacadeDeps): OperationHandler {
  return async (ctx) => provision(deps, ctx, ctx.body as UsersCreateInput);
}

function usersList(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const users = await listProvisionedUsers(deps.db, claimsFor(owner, ctx));
    const result: UsersListResult = { users };
    return result;
  };
}

/**
 * `accountId` comes from the path. Validated as a uuid here rather than trusted,
 * because a path segment is not covered by the body schema that guards
 * everything else on this seam.
 */
function accountIdOf(ctx: Parameters<OperationHandler>[0]): string {
  const raw = ctx.params?.accountId;
  if (typeof raw !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new CollabError('invalid_input', 'accountId must be a uuid');
  }
  return raw;
}

function capabilityGrant(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const accountId = accountIdOf(ctx);
    const { capability } = ctx.body as UserCapabilityInput;
    await grantCapability(deps.db, claimsFor(owner, ctx), accountId, capability);
    return { accountId, capability };
  };
}

function capabilityRevoke(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const accountId = accountIdOf(ctx);
    const { capability } = ctx.body as UserCapabilityInput;
    await revokeCapability(deps.db, claimsFor(owner, ctx), accountId, capability);
    return { accountId, capability };
  };
}

/**
 * `auth.signup` over the control plane.
 *
 * Kept because the UI's first-run gate binds it (`tm8-ui/src/auth/session.ts`),
 * and because breaking a shipped operation to rename it buys nothing. It now
 * provisions a whole user and returns only the account, which is a strict
 * superset of what it used to do — a caller that ignored everything but
 * `account` sees no change, and a person created through it now has somewhere
 * to land.
 *
 * `isNodeAdmin` on the old input is deliberately DROPPED rather than honoured:
 * that flag is the bundle the capability split exists to dismantle, and a
 * provisioning path that can still mint one would keep it alive. Grant the
 * narrow capability afterwards instead.
 */
export function authSignupViaControlPlane(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const provisioned = await provision(deps, ctx, ctx.body as UsersCreateInput);
    const result: AuthSignupResult = { account: provisioned.account };
    return result;
  };
}

export function registerW2UserHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.registerAll({
    'users.create': usersCreate(deps),
    'users.list': usersList(deps),
    'users.capabilities.grant': capabilityGrant(deps),
    'users.capabilities.revoke': capabilityRevoke(deps),
  });
}
