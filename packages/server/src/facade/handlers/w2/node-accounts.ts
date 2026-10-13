/**
 * Node-admin account administration (migration 324, task 01a13574; audit doc
 * 01a13570 §1).
 *
 *   · node.accounts.create          — a passwordless account + a one-time setup link,
 *                                     optionally placed into one space as admin|member
 *   · node.accounts.reset           — clear the credential, revoke every session, new link
 *   · accounts.enable               — the inverse of 232's accounts.disable
 *   · node.accounts.nodeAdmin.set   — grant/revoke node admin (never the owner, never the last)
 *   · node.accounts.memberships.add — put an existing account into a space
 *
 * TWO LAYERS, as for path grants and `auth.signup`: here, a human session with
 * the server-resolved `nodeAdmin` claim (which `claimsFor` already clears for a
 * space-pinned session, K6); in SQL, `internal.require_account_admin()`
 * (human auth kind + gate admin) inside every RPC.
 *
 * NOT `IdentityServiceImpl.resetCredentials`: its repository targets a schema
 * that never landed (identity/loopback.ts, pg-auth.ts header).
 *
 * THE SETUP TOKEN IS A SECRET, so create and reset stay out of the command
 * ledger: a replay could only be answered by storing the plaintext. They accept
 * `clientMutationId` (every non-`auth.*` DTO must) and ignore it.
 */
import {
  ACCOUNT_SETUP_DEFAULT_HOURS,
  AccountsEnableInputSchema,
  CollabError,
  isHumanAuthKind,
  NodeAccountCreateInputSchema,
  NodeAccountMembershipAddInputSchema,
  NodeAccountNodeAdminSetInputSchema,
  NodeAccountResetInputSchema,
  type AccountEnableResult,
  type NodeAccountCreateResult,
  type NodeAccountMembershipAddResult,
  type NodeAccountNodeAdminSetResult,
  type NodeAccountResetResult,
  type NodeAccountView,
} from '@tm8/contract';
import type { ZodTypeAny } from 'zod';

import type { DbClaims } from '../../../db/types.js';
import { fail } from '../../../http/errors.js';
import { json, type RequestContext } from '../../../http/types.js';
import { adminCreateAccount, adminResetAccount } from '../../../identity/pg-auth.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { closeSockets, type MembershipHandlerDeps } from '../../../membership/handlers.js';

export const ACCOUNT_RESET_CLOSE_REASON = 'account credential reset';

export function registerNodeAccountHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  membership: Pick<MembershipHandlerDeps, 'sockets' | 'log'> = {},
): void {
  const log = membership.log ?? ((message, fields) => console.warn(`[node.accounts] ${message}`, fields));

  const adminClaims = async (ctx: RequestContext, envelope = {}): Promise<DbClaims> => {
    // First, so an anonymous caller is `unauthenticated`, not `forbidden`.
    const claims = claimsFor(await deps.owner(), ctx, envelope);
    if (!isHumanAuthKind(ctx.identity.authKind)) {
      throw new CollabError('forbidden', 'accounts are administered from human sessions only', {
        details: { reason: 'human_session_required' },
      });
    }
    if (claims.nodeAdmin !== true) {
      throw new CollabError('forbidden', 'accounts are administered by node admins only', {
        details: { reason: 'node_admin_required' },
      });
    }
    return claims;
  };

  const setupUrl = (token: string): string => {
    const origin = (deps.config.publicOrigin ?? `http://${deps.config.host}:${deps.config.port}`).replace(/\/$/, '');
    return `${origin}/#setup=${encodeURIComponent(token)}`;
  };

  registry.registerAll({
    'node.accounts.create': async (ctx) => {
      const claims = await adminClaims(ctx);
      const input = parseBody(NodeAccountCreateInputSchema, ctx);
      if ((input.spaceId === undefined) !== (input.role === undefined)) {
        throw fail('invalid_input', 'spaceId and role go together');
      }
      const created = await adminCreateAccount(deps.db, claims, {
        username: input.username,
        displayName: input.displayName ?? null,
        email: input.email ?? null,
        isNodeAdmin: input.isNodeAdmin ?? false,
        spaceId: input.spaceId ?? null,
        role: input.role ?? null,
        expiresAt: expiresAt(input.expiresInHours),
      });
      const a = created.account;
      const account: NodeAccountView = {
        accountId: a.id,
        username: a.username,
        ...(a.display_name ? { displayName: a.display_name } : {}),
        status: a.status,
        isNodeAdmin: a.is_node_admin || a.is_owner,
        isOwner: a.is_owner,
        hasPassword: false,
        setupExpiresAt: iso(created.expiresAt),
      };
      const result: NodeAccountCreateResult = {
        account,
        setupToken: created.token,
        setupUrl: setupUrl(created.token),
        expiresAt: iso(created.expiresAt),
        ...(created.spaceId && created.memberId && created.role
          ? { membership: { spaceId: created.spaceId, memberId: created.memberId, role: created.role } }
          : {}),
      };
      return json(result, { status: 201, headers: { 'cache-control': 'no-store' } });
    },

    'node.accounts.reset': async (ctx) => {
      const accountId = requireUuidParam(ctx, 'accountId');
      const claims = await adminClaims(ctx);
      const input = parseBody(NodeAccountResetInputSchema, ctx);
      const reset = await adminResetAccount(deps.db, claims, accountId, expiresAt(input.expiresInHours));
      // The sessions are revoked in SQL; their open sockets are not.
      closeSockets(membership.sockets, reset.identityId, null, ACCOUNT_RESET_CLOSE_REASON, log);
      const result: NodeAccountResetResult = {
        accountId: reset.accountId,
        username: reset.username,
        revokedSessionCount: reset.revokedSessionCount,
        setupToken: reset.token,
        setupUrl: setupUrl(reset.token),
        expiresAt: iso(reset.expiresAt),
      };
      return json(result, { headers: { 'cache-control': 'no-store' } });
    },

    'accounts.enable': async (ctx) => {
      const accountId = requireUuidParam(ctx, 'accountId');
      const claims = await adminClaims(ctx, commandEnvelope(ctx));
      const { clientMutationId } = parseBody(AccountsEnableInputSchema, ctx);
      const result = await deps.db.rpc<AccountEnableResult>(claims, 'enable_account', [accountId, clientMutationId]);
      return result;
    },

    'node.accounts.nodeAdmin.set': async (ctx) => {
      const accountId = requireUuidParam(ctx, 'accountId');
      const claims = await adminClaims(ctx);
      const input = parseBody(NodeAccountNodeAdminSetInputSchema, ctx);
      const row = await deps.db.rpc<NodeAccountNodeAdminSetResult & { identityId?: string }>(
        claims,
        'set_account_node_admin',
        [accountId, input.isNodeAdmin],
      );
      const result: NodeAccountNodeAdminSetResult = { accountId: row.accountId, isNodeAdmin: row.isNodeAdmin };
      return result;
    },

    'node.accounts.memberships.add': async (ctx) => {
      const accountId = requireUuidParam(ctx, 'accountId');
      const claims = await adminClaims(ctx);
      const input = parseBody(NodeAccountMembershipAddInputSchema, ctx);
      const result = await deps.db.rpc<NodeAccountMembershipAddResult>(
        claims,
        'admin_add_space_member',
        [accountId, input.spaceId, input.role],
      );
      return json(result, { status: result.created ? 201 : 200 });
    },
  });
}

function expiresAt(hours: number | undefined): string {
  return new Date(Date.now() + (hours ?? ACCOUNT_SETUP_DEFAULT_HOURS) * 60 * 60 * 1000).toISOString();
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function parseBody<S extends ZodTypeAny>(schema: S, ctx: RequestContext): ReturnType<S['parse']> {
  const parsed = schema.safeParse(ctx.body ?? {});
  if (!parsed.success) {
    throw fail(
      'invalid_input',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data as ReturnType<S['parse']>;
}
