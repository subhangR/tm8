/**
 * The enforce gate (plan 01a0d9eb W3, matrix row T8c).
 *
 * Under `TM8_SPACE_SESSIONS=enforce` a human GATE session — a verified
 * `browser`/`cli` bearer whose `auth_sessions.space_id` is null — is a login,
 * not a workspace. It may read who it is, list its spaces, get into a FIRST
 * space (create one, or redeem an invite), manage its own session, enter a
 * space (`auth.space.enter` mints the pinned session every other call uses),
 * and do node administration, which is gate admin (K6). Everything else is
 * refused before the handler runs.
 *
 * The brand-new-user walk (sign in -> identity.get -> spaces.list ->
 * spaces.create or auth.invite.resolve + spaces.invites.redeem ->
 * auth.space.enter) needs exactly GATE_SPACE_ENTRY_OPS plus `auth.*`; the
 * enforce-blocker cell in cross-space-token.pg.test.ts walks it.
 *
 * Under `off` and `agents` nothing here refuses: a gate session behaves exactly
 * as a human session did before W3.
 *
 * Deliberately NOT gated:
 *   - agent kinds: always pinned (226's check), so never a gate session;
 *   - the loopback auto-owner: it has no session row to pin. Whether enforce
 *     should also refuse it is W2's (TM8_DISABLE_AUTO_OWNER) call, not this
 *     file's.
 */
import { CollabError } from '@tm8/contract';

import type { RequestIdentity, SpaceSessionsMode } from './types.js';

/** Node-admin operation namespaces a gate session keeps (K6: node admin is gate admin). */
const GATE_NODE_ADMIN_PREFIXES: readonly string[] = ['node.', 'serverConnections.'];

/** Non-`auth.*` ops a gate session needs to find, make or join a space. */
const GATE_SPACE_ENTRY_OPS: ReadonlySet<string> = new Set([
  'identity.get',
  'spaces.list',
  'spaces.create',
  'spaces.invites.redeem',
]);

/** Whether `opName` is one a gate session may call under `enforce`. */
export function gateSessionMayCall(opName: string): boolean {
  if (GATE_SPACE_ENTRY_OPS.has(opName)) return true;
  // `auth.*` includes `auth.space.enter`, `auth.session.get`, logout and
  // `auth.invite.resolve` (the invite preview the join screen shows first).
  if (opName.startsWith('auth.')) return true;
  return GATE_NODE_ADMIN_PREFIXES.some((prefix) => opName.startsWith(prefix));
}

/** A verified human session with no space: what enforce restricts. */
export function isGateSession(identity: RequestIdentity): boolean {
  return (
    identity.kind === 'bearer' &&
    !identity.sessionSpaceId &&
    (identity.authKind === 'browser' || identity.authKind === 'cli')
  );
}

/**
 * Throw `forbidden` when `identity` is a gate session calling something the
 * gate does not allow under `enforce`. `opName` is undefined for the non-catalog
 * support routes (file upload, clipboard), which a gate session never may use.
 */
export function assertSpaceGate(
  mode: SpaceSessionsMode | undefined,
  identity: RequestIdentity,
  opName: string | undefined,
): void {
  if (mode !== 'enforce' || !isGateSession(identity)) return;
  if (opName !== undefined && gateSessionMayCall(opName)) return;
  throw new CollabError(
    'forbidden',
    'this session is not in a space; call auth.space.enter first',
  );
}
