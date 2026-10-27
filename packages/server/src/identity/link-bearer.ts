/**
 * 256 (W7p, lead ruling A' and its deny-by-default ruling): a `link` session
 * does nothing on its own bearer.
 *
 * A space link's stored session is the linking human's full membership of the
 * target space. Its token is minted by `DbSpaceLinkStore.login`, sealed, and
 * opened only in-process by `DbSpaceLinkStore.use` — nothing presents it on a
 * wire. Three layers keep it that way:
 *
 * (i) Transport. `createSessionIdentityResolver` (http/identity-resolver.ts),
 *     the one closure every wire entry resolves a bearer through — the HTTP
 *     facade, PUT file upload, POST clipboard upload, the relay, the events
 *     WS and the PTY attach WS — refuses a session of kind `link`. There is
 *     no allow-list at this layer. The refusal sits in that closure, NOT in
 *     the shared `resolveBearerIdentity`, so `use()` still resolves.
 * (ii) Registry. `HandlerRegistry.get` refuses an identity of authKind `link`
 *     on every operation, before the handler (and so before `claimsFor`,
 *     any write, mint or rpc) runs — UNLESS the request context carries the
 *     in-process invoke marker (#884, lead ruling (a)). There is no
 *     allow-list: the one admission is `admitLinkInvoke`, called only by the
 *     `spaceLinks.invoke` in-process executor, after its home-side refused
 *     set (credentials.*, space-credential ops, link token ops, the spawn
 *     rule) has run. The marker is a module-private WeakMap entry keyed on
 *     the context OBJECT and bound to one op name; it is consumed by the
 *     first registry check that sees it. It is never a header, a claim, a
 *     GUC or a body field, so nothing from a wire, a ledger replay or a
 *     child spawn can carry it, and a nested dispatch from inside the inner
 *     handler (same context object or a copy) finds no marker.
 * (iii) Defence in depth. W7b (L4, owner form response 01a0fbb4) lets a link
 *     identity spawn, resume and dispatch in its target through
 *     `spaceLinks.invoke` while its row has allow_spawn on. So
 *     `execution.spawn`, `execution.resume` and `execution.dispatch` call
 *     `refuseLinkBearerSpawn`: a link identity passes only on a context the
 *     invoke executor admitted for exactly that op (`admitLinkInvoke`
 *     records a second, spawn-only marker the handler consumes) and only
 *     while it carries its link (`viaLinkId`). The spawn reader
 *     (`SpaceCredentialStore.readForSpawn`) needs the link claim too.
 *     SQL then decides: `read_space_credential_for_spawn` hands a link-bound
 *     caller B's DEFAULT credential only, and the spawn-path mint
 *     (`issue_work_session_agent_session`) mints only through
 *     `internal.link_provenance_for`, i.e. while the row is signed in with
 *     spawning allowed (256, 277). `issue_agent_auth_session` and the
 *     service-key read (`refuseLinkBearer`) still refuse a link session
 *     outright.
 *
 * An agent minted under a link (authKind `agent`, `viaLinkId` set) is NOT a
 * link bearer and is not refused by any of these; its link-bound rules apply
 * instead.
 */
import { CollabError, SPACE_LINK_SPAWN_OPS, type OperationName } from '@tm8/contract';
import type { DbClaims } from '../db/types.js';

export const LINK_BEARER_SPAWN_REFUSED = 'a space link session cannot spawn, resume or read a spawn credential';
export const LINK_BEARER_TRANSPORT_REFUSED = 'a space link session token is not accepted on any transport';
export const LINK_BEARER_OP_REFUSED = 'a space link session cannot call this operation';
export const LINK_BEARER_SPAWN_UNADMITTED =
  'a space link session may spawn, resume or dispatch only through spaceLinks.invoke, under its link';

/**
 * Layer (ii)'s one admission: context object -> the op it may run. Module
 * private and weakly held, so it cannot be serialised, forged by value or
 * outlive the request.
 */
const LINK_INVOKE_ADMITTED = new WeakMap<object, OperationName>();

/**
 * Layer (iii)'s admission for a spawn op (W7b): set beside the registry
 * marker, consumed by the spawn, resume or dispatch handler itself. The
 * registry's marker is gone by then, so this is the handler's own proof that
 * the invoke executor, after its home-side refused set and allow_spawn check,
 * dispatched exactly this op on exactly this context.
 */
const LINK_SPAWN_ADMITTED = new WeakMap<object, OperationName>();

/**
 * Mark ONE in-process dispatch of `name` on `ctx` as the `spaceLinks.invoke`
 * executor's. Only space-link-invoke.ts may call this (pinned by
 * link-bearer-refused.test.ts); it runs after the home-side refused set.
 */
export function admitLinkInvoke(ctx: object, name: OperationName): void {
  LINK_INVOKE_ADMITTED.set(ctx, name);
  if (SPACE_LINK_SPAWN_OPS.includes(name)) LINK_SPAWN_ADMITTED.set(ctx, name);
}

function refused(message: string): CollabError {
  return new CollabError('forbidden', message, { details: { sqlstate: '42501' } });
}

/** Layer (i): the inbound resolver's refusal, by the verified session row's kind. */
export function refuseLinkSessionOnTransport(sessionKind: string): void {
  if (sessionKind === 'link') throw refused(LINK_BEARER_TRANSPORT_REFUSED);
}

/**
 * Layer (ii): the registry's default-deny. A link identity passes only on a
 * context the invoke executor marked for exactly this op; the marker is
 * consumed here, so it admits one dispatch and no nested one.
 */
export function refuseLinkBearerOp(name: OperationName, ctx: { identity?: { authKind?: string } }): void {
  if (ctx.identity?.authKind !== 'link') return;
  const admitted = LINK_INVOKE_ADMITTED.get(ctx);
  LINK_INVOKE_ADMITTED.delete(ctx);
  if (admitted !== name) throw refused(LINK_BEARER_OP_REFUSED);
}

/** Layer (iii): the per-operation refusal (the service-key read). */
export function refuseLinkBearer(claims: Pick<DbClaims, 'authKind'>): void {
  if (claims.authKind === 'link') throw refused(LINK_BEARER_SPAWN_REFUSED);
}

/**
 * Layer (iii) for `execution.spawn`, `execution.resume` and
 * `execution.dispatch` (W7b): a link identity passes only on a context the
 * invoke executor admitted for this op, and only with its link claim. Any
 * other caller is untouched.
 */
export function refuseLinkBearerSpawn(
  ctx: { opName?: string },
  claims: Pick<DbClaims, 'authKind' | 'viaLinkId'>,
): void {
  if (claims.authKind !== 'link') return;
  const admitted = LINK_SPAWN_ADMITTED.get(ctx);
  LINK_SPAWN_ADMITTED.delete(ctx);
  if (!claims.viaLinkId || admitted === undefined || admitted !== ctx.opName) {
    throw refused(LINK_BEARER_SPAWN_UNADMITTED);
  }
}

/**
 * The spawn credential read (W7b): a link session reads only with its link
 * claim, so SQL's link-bound branch (B's default credential, row signed in
 * with spawning allowed) decides.
 */
export function refuseUnlinkedLinkBearer(claims: Pick<DbClaims, 'authKind' | 'viaLinkId'>): void {
  if (claims.authKind === 'link' && !claims.viaLinkId) throw refused(LINK_BEARER_SPAWN_REFUSED);
}
