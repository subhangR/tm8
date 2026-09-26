/**
 * 992 (W7p, lead ruling A' and its deny-by-default ruling): a `link` session
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
 *     on every operation not in `LINK_BEARER_ALLOWED_OPS`, before the
 *     handler (and so before `claimsFor`, any write, mint or rpc) runs. The
 *     list is EMPTY; #884 adds `spaceLinks.invoke` with its marker, and
 *     nothing else.
 * (iii) Defence in depth. `execution.spawn`, `execution.resume`,
 *     `execution.dispatch` and the spawn reader
 *     (`SpaceCredentialStore.readForSpawn`) refuse it again with
 *     `refuseLinkBearer`; SQL `read_space_credential_for_spawn` and the
 *     spawn-path agent-session mint (`issue_work_session_agent_session`,
 *     called by `DbGraphPort.issueWorkSessionAgentToken`) refuse
 *     `tm8.auth_kind = 'link'` as their first statement.
 *
 * An agent minted under a link (authKind `agent`, `viaLinkId` set) is NOT a
 * link bearer and is not refused by any of these; its link-bound rules apply
 * instead.
 */
import { CollabError, type OperationName } from '@tm8/contract';
import type { DbClaims } from '../db/types.js';

export const LINK_BEARER_SPAWN_REFUSED = 'a space link session cannot spawn, resume or read a spawn credential';
export const LINK_BEARER_TRANSPORT_REFUSED = 'a space link session token is not accepted on any transport';
export const LINK_BEARER_OP_REFUSED = 'a space link session cannot call this operation';

/** Layer (ii)'s allow-list. Empty in #898: #884 adds its invoke route only. */
export const LINK_BEARER_ALLOWED_OPS: ReadonlySet<OperationName> = new Set<OperationName>();

function refused(message: string): CollabError {
  return new CollabError('forbidden', message, { details: { sqlstate: '42501' } });
}

/** Layer (i): the inbound resolver's refusal, by the verified session row's kind. */
export function refuseLinkSessionOnTransport(sessionKind: string): void {
  if (sessionKind === 'link') throw refused(LINK_BEARER_TRANSPORT_REFUSED);
}

/** Layer (ii): the registry's default-deny. */
export function refuseLinkBearerOp(name: OperationName, authKind: string | undefined): void {
  if (authKind === 'link' && !LINK_BEARER_ALLOWED_OPS.has(name)) throw refused(LINK_BEARER_OP_REFUSED);
}

/** Layer (iii): the per-operation refusal. */
export function refuseLinkBearer(claims: Pick<DbClaims, 'authKind'>): void {
  if (claims.authKind === 'link') throw refused(LINK_BEARER_SPAWN_REFUSED);
}
