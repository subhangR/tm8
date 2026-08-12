/**
 * auth.* — local accounts (Identity v2 Stage 1, doc 4 §6).
 *
 * Four operations, and the seam is deliberately thin: every authorization
 * decision except the scrypt comparison lives inside 007's SECURITY DEFINER
 * RPCs (`ensure_account`'s F1 node-admin gate, `revoke_auth_session`'s
 * self-or-admin gate, `resolve_auth_session`'s revocation/expiry/status
 * checks). The handlers bind the right claims and translate shapes.
 *
 * These commands sit OUTSIDE the idempotency ledger on purpose: a session row
 * is not a graph mutation, so there is no `clientMutationId` and no replay
 * short-circuit. The DTOs are strict and refuse `actorId` — authentication
 * has no authoring persona.
 */
import { CollabError } from '@tm8/contract';
import type {
  AuthAccountView,
  AuthLoginInput,
  AuthLoginResult,
  AuthLogoutInput,
  AuthLogoutResult,
  AuthSessionGetResult,
} from '@tm8/contract';

import { clearSessionCookie, sessionCookie } from '../../../http/session-cookie.js';
import { json, type OperationHandler, type RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor } from '../../context.js';
import { authSignupViaControlPlane } from './users.js';
import {
  loginWithPassword,
  resolveBearerIdentity,
  type AccountRowJson,
} from '../../../identity/pg-auth.js';

function accountView(row: AccountRowJson): AuthAccountView {
  return {
    accountId: row.id,
    identityId: row.identity_id,
    username: row.username,
    displayName: row.display_name,
    isNodeAdmin: row.is_node_admin,
    isOwner: row.is_owner,
  };
}

/**
 * `auth.signup` now runs through the control plane — see
 * `handlers/w2/users.ts` `authSignupViaControlPlane`. The handler that used to
 * live here called `signupAccount`, which wrote an account and nothing else;
 * both it and that function are gone rather than kept as a second, divergent
 * way to make a user.
 */

/** `auth.login` — claim-free credential exchange; the only path that returns a token. */
function authLogin(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const body = ctx.body as AuthLoginInput;
    const issued = await loginWithPassword(
      deps.db,
      {
        username: body.username,
        password: body.password,
        ...(body.kind ? { kind: body.kind } : {}),
        label: body.label ?? null,
      },
      ctx.requestId,
    );
    const result: AuthLoginResult = {
      token: issued.token,
      account: issued.account,
      session: issued.session,
    };
    if ((body.kind ?? 'browser') !== 'browser') return result;
    return json(result, {
      headers: {
        'cache-control': 'no-store',
        'set-cookie': sessionCookie(issued.token, issued.session.expiresAt),
      },
    });
  };
}

/**
 * `auth.logout` — revoke the presented session, or an explicitly named one.
 * `revoke_auth_session` enforces self-or-node-admin in SQL under the caller's
 * claims, so naming someone else's session is a 42501, not a hidden no-op.
 */
function authLogout(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const body = (ctx.body ?? {}) as AuthLogoutInput;
    const sessionId = body.sessionId ?? ctx.identity.sessionId;
    if (!sessionId) {
      throw new CollabError(
        'invalid_input',
        'no session to revoke: pass sessionId, or authenticate with the bearer token to revoke',
      );
    }
    await deps.db.rpc(claimsFor(owner, ctx), 'revoke_auth_session', [sessionId]);
    const result: AuthLogoutResult = { sessionId, revoked: true };
    return json(result, {
      headers: {
        'cache-control': 'no-store',
        'set-cookie': clearSessionCookie(),
      },
    });
  };
}

/**
 * `auth.session.get` — who am I on this server. A bearer caller's token is
 * re-verified live (revocation and account disablement surface immediately);
 * the loopback auto-owner answers without a session row, which is the
 * degenerate case T-L7 requires to keep working.
 */
function authSessionGet(deps: FacadeDeps): OperationHandler {
  return async (ctx: RequestContext) => {
    if (ctx.identity.kind === 'bearer') {
      if (!ctx.identity.token) {
        throw new CollabError('unauthenticated', 'bearer session is unresolved');
      }
      const session = await resolveBearerIdentity(deps.db, ctx.identity.token);
      const displayName = await profileDisplayName(deps, session.identityId, ctx.requestId);
      const result: AuthSessionGetResult = {
        authKind: 'bearer',
        account: {
          accountId: session.accountId,
          identityId: session.identityId,
          username: session.username,
          displayName: displayName ?? session.displayName,
          isNodeAdmin: session.isNodeAdmin,
          isOwner: session.isOwner,
        },
        session: {
          sessionId: session.sessionId,
          kind: session.kind,
          actingAsTeamMemberId: session.actingAsTeamMemberId,
          label: session.label,
          expiresAt: session.expiresAt,
        },
      };
      // Browser passes issued before cookie-backed WebSockets shipped still
      // live in the per-origin pass store and authenticate every HTTP read,
      // but native WebSocket constructors cannot attach their Authorization
      // header. Refresh the same verified browser session into its Secure,
      // HttpOnly carrier during the gate's normal reload check. CLI and agent
      // sessions must never be upgraded into ambient browser authority.
      if (session.kind === 'browser') {
        return json(result, {
          headers: {
            'cache-control': 'no-store',
            'set-cookie': sessionCookie(ctx.identity.token, session.expiresAt),
          },
        });
      }
      return result;
    }

    if (ctx.identity.kind === 'anonymous') {
      throw new CollabError('unauthenticated', 'authentication is required');
    }

    const owner = await deps.owner();
    const displayName = await profileDisplayName(deps, owner.identityId, ctx.requestId);
    const result: AuthSessionGetResult = {
      authKind: 'auto-owner',
      account: {
        accountId: owner.accountId,
        identityId: owner.identityId,
        username: owner.username,
        displayName,
        isNodeAdmin: owner.isNodeAdmin,
        isOwner: owner.isOwner,
      },
      session: null,
    };
    return result;
  };
}

/** user_profiles' self-select policy admits this read under the subject's own claims. */
async function profileDisplayName(
  deps: FacadeDeps,
  identityId: string,
  requestId: string,
): Promise<string | null> {
  const rows = await deps.db.query<{ display_name: string | null }>(
    { identityId, requestId },
    'select display_name from public.user_profiles where identity_id = $1',
    [identityId],
  );
  return rows[0]?.display_name ?? null;
}

/** The complete auth seam — one registration, one honest group. */
export function registerW2AuthHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.registerAll({
    // Over the control plane, so signup and `users.create` cannot drift into
    // two different notions of what a user is.
    'auth.signup': authSignupViaControlPlane(deps),
    'auth.login': authLogin(deps),
    'auth.logout': authLogout(deps),
    'auth.session.get': authSessionGet(deps),
  });
}
