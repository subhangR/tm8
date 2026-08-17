/**
 * auth.* — local accounts (Identity v2 Stage 1, doc 4 §6).
 *
 * Ten operations, and the seam is deliberately thin: every authorization
 * decision except the scrypt comparison lives inside the SECURITY DEFINER
 * RPCs (`ensure_account`'s F1 node-admin gate, `revoke_auth_session`'s
 * self-or-admin gate, `resolve_auth_session`'s revocation/expiry/status
 * checks, 116's `claim_node` single-use token burn, and 141's
 * `signup_via_invite`/`revoke_account_sessions_except`). The handlers bind the
 * right claims and translate shapes.
 *
 * FIVE OF THE TEN ARE CLAIM-FREE, and that is a property to preserve rather
 * than an omission to tidy up: `auth.login`, `auth.claim`, `auth.claim.status`,
 * `auth.invite.resolve` and `auth.invite.signup` are reachable on a node where
 * the caller has no credential — the bootstrap hole every other operation is
 * spared from needing. `auth.claim.reissue` is the sixth first-run operation but
 * is NOT claim-free: it admits only the loopback auto-owner, because the token
 * it mints is a node-ownership capability. See docs/identity/FIRST-RUN-CLAIM-DESIGN.md.
 *
 * This count is load-bearing and goes stale silently: it read "Four" on the
 * members branch while five were registered, "Six" here after the merge union
 * made it seven, and "Seven" until 141 added the three account-lifecycle ops.
 * If you add an operation below, change this line.
 *
 * These commands sit OUTSIDE the idempotency ledger on purpose: a session row
 * is not a graph mutation, so there is no `clientMutationId` and no replay
 * short-circuit. The DTOs are strict and refuse `actorId` — authentication
 * has no authoring persona.
 */
import { CollabError } from '@tm8/contract';
import type {
  AuthAccountView,
  AuthClaimInput,
  AuthClaimReissueResult,
  AuthClaimResult,
  AuthClaimStatusResult,
  AuthInviteSignupInput,
  AuthInviteSignupResult,
  AuthLoginInput,
  AuthLoginResult,
  AuthLogoutInput,
  AuthLogoutResult,
  AuthPasswordChangeInput,
  AuthPasswordChangeResult,
  AuthSessionGetResult,
  AuthSignupInput,
  AuthSignupResult,
  InvitePreview,
  ResolveInviteInput,
} from '@tm8/contract';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveServerDataDir } from '../../../http/config.js';
import { clearSessionCookie, sessionCookie } from '../../../http/session-cookie.js';
import { json, type OperationHandler, type RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor } from '../../context.js';
import {
  changePassword,
  claimNode,
  issueNodeClaimToken,
  loginWithPassword,
  nodeIsClaimed,
  resolveBearerIdentity,
  signupAccount,
  signupViaInvite,
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
 * `auth.signup` — node-admin provisioning. The gate is `ensure_account`'s F1
 * guard, evaluated in SQL under the CALLER's claims: an unauthenticated
 * caller gets 28000, a non-admin 42501. No open self-registration.
 */
function authSignup(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const body = ctx.body as AuthSignupInput;
    const account = await signupAccount(deps.db, claimsFor(owner, ctx), {
      username: body.username,
      password: body.password,
      displayName: body.displayName ?? null,
      email: body.email ?? null,
      isNodeAdmin: body.isNodeAdmin ?? false,
    });
    const result: AuthSignupResult = { account: accountView(account) };
    return result;
  };
}

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
          ...(session.runtimeMemberId
            ? { runtimeMemberId: session.runtimeMemberId }
            : {}),
          ...(session.runtimeThreadRootId
            ? { runtimeThreadRootId: session.runtimeThreadRootId }
            : {}),
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

/**
 * `auth.invite.resolve` — what a join code lets you join, before the holder is
 * anybody on this node (118).
 *
 * CLAIM-FREE, and that is the requirement rather than an oversight. A join link
 * is opened by someone with no account, or with one and no membership in the
 * space the code names, so every claim-bound path correctly answers with
 * nothing. `claimsFor` REFUSES an anonymous caller outright (context.ts:72), so
 * this handler must not call it — it passes `{}` exactly as `loginWithPassword`
 * does, for exactly the same reason: the caller has no identity until they
 * answer, and the code is the only thing they are presenting.
 *
 * It does not fork the identity path. There is still one `claimsFor` and one
 * resolver; this is a handler that declines to bind claims, which is what
 * 007's existing claim-free holes already are.
 *
 * WHAT MAY BE DISCLOSED IS DECIDED IN SQL (`public.preview_invite`), so one
 * rule serves every transport. This handler neither widens it nor narrows it.
 * The short version: an unresolvable code returns `{status:'unknown'}` and
 * nothing else; a dead code names the space (so the holder can ask the right
 * person for a fresh one) but never the inviter.
 */
function authInviteResolve(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const body = ctx.body as ResolveInviteInput;
    return deps.db.rpc<InvitePreview>({ requestId: ctx.requestId }, 'preview_invite', [body.code]);
  };
}

/** The complete auth seam — one registration, one honest group. */
/**
 * `auth.claim` — the first-run ceremony (design D1/D2).
 *
 * CLAIM-FREE, and it must stay that way: it is the operation that exists
 * because there is no credential on the node yet. `claimsFor` is deliberately
 * NOT called — every guard lives in `claim_node`, under one lock, where the
 * token check, the single-use burn and the re-assertion that the node is still
 * unclaimed cannot be separated by a race.
 *
 * REFUSAL SHAPES, and why they are not all the same. A wrong or already-burned
 * token is `unauthenticated`, with the same words for both — the reason
 * `auth.login` refuses to distinguish an unknown username from a wrong
 * password. A token presented against an already-CLAIMED node is `forbidden`,
 * because `claim_node` re-asserts the node's state before it burns anything
 * and that guard order is what makes a leaked token inert. Saying so leaks
 * nothing: `auth.claim.status` publishes `claimed` to anonymous callers by
 * design, so this is a fact the caller can already read — and it is far more
 * actionable than a generic credential refusal.
 */
function authClaim(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const body = ctx.body as AuthClaimInput;
    const issued = await claimNode(
      deps.db,
      {
        token: body.token,
        username: body.username,
        password: body.password,
        displayName: body.displayName ?? null,
        email: body.email ?? null,
        ...(body.kind ? { kind: body.kind } : {}),
      },
      ctx.requestId,
    );
    const result: AuthClaimResult = {
      token: issued.token,
      account: issued.account,
      session: issued.session,
    };
    // Claiming signs you in, so a browser claim carries the same Secure,
    // HttpOnly carrier a browser login does — otherwise the ceremony would end
    // with a session the app's WebSockets cannot authenticate.
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
 * `auth.claim.status` — the bootstrap read, answerable with no credential.
 *
 * This is the operation that lets the UI gate stop guessing. It previously
 * decided between "create the first account" and "sign in" from a
 * BROWSER-LOCAL list, which is not a fact about the node: a fresh browser
 * profile against a populated node offered a signup that then conflicted, and
 * a stale entry pinned a browser to the sign-in card forever.
 *
 * `signupPath` reports what this node will actually accept right now, so the
 * gate renders a truth rather than an inference.
 */
function authClaimStatus(deps: FacadeDeps): OperationHandler {
  return async () => {
    const claimed = await nodeIsClaimed(deps.db);
    const mode = deps.config.nodeMode ?? 'single';
    const result: AuthClaimStatusResult = {
      claimed,
      mode,
      // Unclaimed: the claim token is the only way in. Claimed: an invite now
      // authorizes its bearer to self-signup (`auth.invite.signup`, 141), so
      // `invite` is the honest answer — the exact change §10.0 required in the
      // SAME commit that lands the signup operation, because until it existed
      // `invite` was vocabulary nothing could return and `admin` was the truth.
      // A node admin can still provision through `auth.signup`, but the primary
      // route for a new person on a claimed node is redeeming an invite.
      signupPath: claimed ? 'invite' : 'claim',
    };
    return result;
  };
}

/**
 * `auth.claim.reissue` — rotate the first-run claim token when the printed one
 * is lost (design §3.1, §4.3).
 *
 * ON-BOX BY CONSTRUCTION. It admits ONLY the loopback auto-owner arm — the
 * server's strongest on-box signal (loopback peer, no forwarded headers,
 * auto-owner enabled), and the same trust this design already extends to a
 * loopback caller acting as owner without a password. The fresh token is a
 * node-ownership capability, so admitting a remote caller would let a stranger
 * force-rotate the operator's saved link (a real, if low-severity, denial) and,
 * far worse, read the token they just minted. Neither is possible here: an
 * anonymous or bearer caller is refused, and the plaintext travels only over
 * this loopback-gated response and into the 0600 `<dataDir>/setup-token`.
 *
 * Inert on a CLAIMED node: `issue_node_claim_token` refuses (a claimed node's
 * token authorizes nothing), and this handler refuses one step earlier with a
 * message an operator can act on rather than a raw constraint error.
 *
 * An ordinary restart REPRINTS the live token (node-claim-boot.ts) rather than
 * rotating it, so this is the deliberate act §3.1 leans on.
 */
function authClaimReissue(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    if (ctx.identity.kind !== 'auto-owner') {
      throw new CollabError(
        'forbidden',
        'reissue is on-box only: run it on the server host, where the loopback owner is trusted',
      );
    }
    if (await nodeIsClaimed(deps.db)) {
      throw new CollabError(
        'forbidden',
        'this node is already claimed; its claim token is inert, so there is nothing to reissue',
      );
    }

    const token = await issueNodeClaimToken(deps.db);

    // The durable copy the boot path also writes, so the NEXT restart reprints
    // this reissued token instead of minting a third one over the top of it.
    // Failing to write it must not fail the reissue — the token is already valid
    // and already in this response — so a write error becomes `tokenPath: null`.
    const dataDir = deps.config.dataDir ?? resolveServerDataDir();
    const tokenPath = join(dataDir, 'setup-token');
    let written: string | null = tokenPath;
    try {
      await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
      await chmod(tokenPath, 0o600);
    } catch {
      written = null;
    }

    const origin = (deps.config.publicOrigin ?? `http://${deps.config.host}:${deps.config.port}`)
      .replace(/\/$/, '');
    const result: AuthClaimReissueResult = {
      token,
      claimUrl: `${origin}/#claim=${encodeURIComponent(token)}`,
      tokenPath: written,
    };
    return result;
  };
}

/**
 * `auth.password.change` — rotate your OWN credential (design §10.3).
 *
 * CHANGE, NOT RESET. The caller is already authenticated — a bearer session or
 * the loopback auto-owner — but must still prove the CURRENT password inside
 * `changePassword`, so a walk-up on an open session cannot silently lock the
 * owner out. An anonymous caller is refused: there is no account to rotate.
 *
 * The keep-alive session is this caller's own: a bearer caller keeps the exact
 * session that made the change (so their shell/browser stays signed in), and
 * every other live session for the account dies. A loopback auto-owner carries
 * no session, so nothing is spared and the count is every live bearer session.
 */
function authPasswordChange(deps: FacadeDeps): OperationHandler {
  return async (ctx: RequestContext) => {
    const body = ctx.body as AuthPasswordChangeInput;

    let accountId: string;
    let identityId: string;
    let username: string;
    let keepSessionId: string | null;

    if (ctx.identity.kind === 'bearer') {
      if (!ctx.identity.token) {
        throw new CollabError('unauthenticated', 'bearer session is unresolved');
      }
      const session = await resolveBearerIdentity(deps.db, ctx.identity.token);
      accountId = session.accountId;
      identityId = session.identityId;
      username = session.username;
      keepSessionId = session.sessionId;
    } else if (ctx.identity.kind === 'anonymous') {
      throw new CollabError('unauthenticated', 'authentication is required');
    } else {
      const owner = await deps.owner();
      accountId = owner.accountId;
      identityId = owner.identityId;
      username = owner.username;
      keepSessionId = null;
    }

    const changed = await changePassword(
      deps.db,
      {
        accountId,
        identityId,
        username,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        keepSessionId,
      },
      ctx.requestId,
    );
    const result: AuthPasswordChangeResult = changed;
    return json(result, { headers: { 'cache-control': 'no-store' } });
  };
}

/**
 * `auth.invite.signup` — redeem an invite that CREATES your account (design D5).
 *
 * CLAIM-FREE, exactly like `auth.invite.resolve`: the invited person has no
 * identity until this call, so `claimsFor` is deliberately NOT invoked and the
 * INVITE CODE is the authorization. `signup_via_invite` creates the account,
 * profile and membership and consumes the invite atomically, minting a non-admin
 * non-owner account no input can escalate.
 *
 * Signing up SIGNS YOU IN — a browser call carries the same Secure, HttpOnly
 * cookie a browser login does, so the ceremony ends inside the app rather than
 * at a sign-in card asking the person to re-type what they just chose.
 */
function authInviteSignup(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const body = ctx.body as AuthInviteSignupInput;
    const issued = await signupViaInvite(
      deps.db,
      {
        code: body.code,
        username: body.username,
        password: body.password,
        displayName: body.displayName ?? null,
        email: body.email ?? null,
        ...(body.kind ? { kind: body.kind } : {}),
      },
      ctx.requestId,
    );
    const result: AuthInviteSignupResult = {
      token: issued.token,
      account: issued.account,
      session: issued.session,
      spaceId: issued.spaceId,
      memberId: issued.memberId,
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

/** The complete auth seam — one registration, one honest group. */
export function registerW2AuthHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.registerAll({
    'auth.signup': authSignup(deps),
    'auth.login': authLogin(deps),
    'auth.logout': authLogout(deps),
    'auth.session.get': authSessionGet(deps),
    'auth.claim': authClaim(deps),
    'auth.claim.status': authClaimStatus(deps),
    'auth.claim.reissue': authClaimReissue(deps),
    'auth.password.change': authPasswordChange(deps),
    'auth.invite.resolve': authInviteResolve(deps),
    'auth.invite.signup': authInviteSignup(deps),
  });
}
