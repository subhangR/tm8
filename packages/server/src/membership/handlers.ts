/**
 * `spaces.leave`, `spaces.members.remove`, `accounts.disable` — G6 (plan
 * 01a0d9eb W1, migration 232).
 *
 * THE TRANSACTION is SQL's: `leave_space` / `remove_space_member` tombstone
 * the member and, in the same commit, revoke the tokens pinned to the space,
 * record their live sessions exited, deactivate their personas and clear their
 * assignments (`internal.end_membership`). `disable_account` disables and
 * revokes every session (007's `set_account_disabled`).
 *
 * THE TS STEP, after commit, is what SQL cannot reach:
 *   · the PTYs — `killRecordedEnding` for a membership end (the ending is
 *     already recorded, under nobody's captured claims), and
 *     `containCredentialSession` for an account disable (the launcher is
 *     still a member, so its captured claims record the ending, exactly as
 *     `IdentityService.disableAccount`'s SC-6 seam does);
 *   · the open event sockets — every socket of that identity subscribed to
 *     the space (every socket of it, for a disable) is closed with 1008.
 *     Subscription admission is checked only at subscribe time, so a socket
 *     left open would keep receiving the space's events.
 *
 * Best effort after commit, like SC-6: the revocation already happened, so a
 * failed kill or close is logged, never thrown — the command did succeed. A
 * replay re-runs the step, which is idempotent (`not_found`, no sockets).
 *
 * `IdentityServiceImpl.disableAccount` is not composed in production (its
 * `PgIdentityRepository` targets a schema that never landed — pg-auth.ts:6),
 * so `accounts.disable` follows its order here: disable + revoke, then contain.
 */
import {
  AccountsDisableInputSchema,
  SpacesLeaveInputSchema,
  SpacesMembersRemoveInputSchema,
  type AccountDisableResult,
  type MembershipEndResult,
} from '@tm8/contract';
import type { ZodTypeAny } from 'zod';

import { claimsFor, commandEnvelope, requireUuidParam } from '../facade/context.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { fail } from '../http/errors.js';
import type { RequestContext } from '../http/types.js';
import type { EventSink } from '../events/ws-connection.js';
import { CLOSE_CODE } from '../events/ws-frame.js';

/** The PTY-side of containment. `SpawnService` implements both. */
export interface MembershipSessionPort {
  killRecordedEnding(sessionId: string): Promise<string>;
  containCredentialSession(sessionId: string, cause: 'member_removed'): Promise<unknown>;
}

/** The live event sockets (`SubscriptionRegistry`). */
export interface MembershipSocketPort {
  sinks(): EventSink[];
  spacesFor(connId: string): string[];
}

export interface MembershipHandlerDeps {
  /** Absent on a node with no execution runtime: there are no PTYs to kill. */
  readonly sessions?: MembershipSessionPort;
  readonly sockets?: MembershipSocketPort;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

/** What the SQL returns: the public shape plus the identity the TS step needs. */
type WithIdentity<T> = T & { identityId?: string };

export const MEMBERSHIP_ENDED_CLOSE_REASON = 'membership ended';
export const ACCOUNT_DISABLED_CLOSE_REASON = 'account disabled';

export function registerMembershipHandlers(
  registry: HandlerRegistry,
  facade: FacadeDeps,
  deps: MembershipHandlerDeps = {},
): void {
  const log = deps.log ?? ((message, fields) => console.warn(`[membership] ${message}`, fields));

  registry.register('spaces.leave', async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const { clientMutationId } = parseBody(SpacesLeaveInputSchema, ctx);
    const owner = await facade.owner();
    const result = await facade.db.rpc<WithIdentity<MembershipEndResult>>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'leave_space',
      [spaceId, clientMutationId],
    );
    await afterMembershipEnded(result, deps, log);
    return publicShape(result);
  });

  registry.register('spaces.members.remove', async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const memberId = requireUuidParam(ctx, 'memberId');
    const { clientMutationId } = parseBody(SpacesMembersRemoveInputSchema, ctx);
    const owner = await facade.owner();
    const result = await facade.db.rpc<WithIdentity<MembershipEndResult>>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'remove_space_member',
      [spaceId, memberId, clientMutationId],
    );
    await afterMembershipEnded(result, deps, log);
    return publicShape(result);
  });

  registry.register('accounts.disable', async (ctx) => {
    const accountId = requireUuidParam(ctx, 'accountId');
    const { clientMutationId } = parseBody(AccountsDisableInputSchema, ctx);
    const owner = await facade.owner();
    const result = await facade.db.rpc<WithIdentity<AccountDisableResult>>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'disable_account',
      [accountId, clientMutationId],
    );
    for (const sessionId of result.stoppedSessionIds ?? []) {
      try {
        await deps.sessions?.containCredentialSession(sessionId, 'member_removed');
      } catch (error) {
        log('containment of a disabled account\'s session failed', { sessionId, reason: reasonOf(error) });
      }
    }
    if (result.identityId) {
      closeSockets(deps.sockets, result.identityId, null, ACCOUNT_DISABLED_CLOSE_REASON, log);
    }
    return publicShape(result);
  });
}

async function afterMembershipEnded(
  result: WithIdentity<MembershipEndResult>,
  deps: MembershipHandlerDeps,
  log: NonNullable<MembershipHandlerDeps['log']>,
): Promise<void> {
  for (const sessionId of result.stoppedSessionIds ?? []) {
    try {
      const outcome = await deps.sessions?.killRecordedEnding(sessionId);
      if (outcome === 'error') log('the PTY host could not kill a session after its membership ended', { sessionId });
    } catch (error) {
      log('killing a session after its membership ended failed', { sessionId, reason: reasonOf(error) });
    }
  }
  if (result.identityId) {
    closeSockets(deps.sockets, result.identityId, result.spaceId, MEMBERSHIP_ENDED_CLOSE_REASON, log);
  }
}

/**
 * Close every open socket of `identityId` subscribed to `spaceId` (any space
 * when null). Returns how many were closed. Exported for the tests.
 */
export function closeSockets(
  sockets: MembershipSocketPort | undefined,
  identityId: string,
  spaceId: string | null,
  reason: string,
  log?: MembershipHandlerDeps['log'],
): number {
  if (!sockets) return 0;
  let closed = 0;
  for (const sink of sockets.sinks()) {
    if (!sink.isOpen || sink.identity.identityId !== identityId) continue;
    if (spaceId !== null && !sockets.spacesFor(sink.id).includes(spaceId)) continue;
    try {
      sink.close(CLOSE_CODE.policyViolation, reason);
      closed += 1;
    } catch (error) {
      log?.('closing a socket after a membership ended failed', { connId: sink.id, reason: reasonOf(error) });
    }
  }
  return closed;
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

function publicShape<T extends { identityId?: string }>(result: T): Omit<T, 'identityId'> {
  const { identityId: _identityId, ...rest } = result;
  return rest;
}

/** An error's code or class name: never its message, which may quote input. */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown';
}
