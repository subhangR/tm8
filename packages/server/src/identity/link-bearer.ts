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
 * (iii) Defence in depth. `execution.resume` and `execution.dispatch`
 *     refuse it again with `refuseLinkBearer`, and `issue_agent_auth_session`
 *     refuses `tm8.auth_kind = 'link'` as its first statement. W7b (996)
 *     opens exactly one launch: `execution.spawn` calls SQL
 *     `admit_space_link_spawn`, which admits a link identity only against a
 *     live, unbound spawn reservation that `spaceLinks.invoke` made on the
 *     same token row (and re-checks T33); SQL `read_space_credential_for_spawn`
 *     and `issue_work_session_agent_session` admit it only against that
 *     reservation too (the mint binds it to the new session). No reservation,
 *     no launch, whatever reached the handler. W9 R-2: a link-bound AGENT
 *     (below) launches nothing — `execution.spawn` and
 *     `execution.terminal.start` refuse it (`refuseLinkBoundLaunch`), as do
 *     both agent mints and `start_shell_session` in SQL; the terminal refuses
 *     the link session too.
 *
 * An agent minted under a link (authKind `agent`, `viaLinkId` set) is NOT a
 * link bearer; its link-bound rules apply instead, and it starts no session.
 */
import { CollabError, type OperationName } from '@tm8/contract';
import type { DbClaims } from '../db/types.js';

export const LINK_BEARER_SPAWN_REFUSED = 'a space link session cannot spawn, resume or read a spawn credential';
export const LINK_BEARER_TRANSPORT_REFUSED = 'a space link session token is not accepted on any transport';
export const LINK_BEARER_OP_REFUSED = 'a space link session cannot call this operation';
export const LINK_BOUND_LAUNCH_REFUSED = 'a session started through a space link cannot start another session';

/**
 * Layer (ii)'s one admission: context object -> the op it may run. Module
 * private and weakly held, so it cannot be serialised, forged by value or
 * outlive the request.
 */
const LINK_INVOKE_ADMITTED = new WeakMap<object, OperationName>();

/**
 * Mark ONE in-process dispatch of `name` on `ctx` as the `spaceLinks.invoke`
 * executor's. Only space-link-invoke.ts may call this (pinned by
 * link-bearer-refused.test.ts); it runs after the home-side refused set.
 */
export function admitLinkInvoke(ctx: object, name: OperationName): void {
  LINK_INVOKE_ADMITTED.set(ctx, name);
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

/**
 * W9 R-2: a link-bound AGENT (authKind `agent` with `viaLinkId` — the reserved
 * spawn and anything under it) launches nothing, so the link's budget counts
 * every process it starts. SQL refuses the same in both agent mints and
 * `start_shell_session`. `includeLink` also refuses the link session itself
 * (a terminal is never a reserved launch).
 */
export function refuseLinkBoundLaunch(claims: Pick<DbClaims, 'authKind' | 'viaLinkId'>, includeLink = false): void {
  const linkBoundAgent = claims.authKind !== 'link' && Boolean(claims.viaLinkId);
  if (linkBoundAgent || (includeLink && claims.authKind === 'link')) throw refused(LINK_BOUND_LAUNCH_REFUSED);
}

/** Layer (iii): the per-operation refusal. */
export function refuseLinkBearer(claims: Pick<DbClaims, 'authKind'>): void {
  if (claims.authKind === 'link') throw refused(LINK_BEARER_SPAWN_REFUSED);
}
