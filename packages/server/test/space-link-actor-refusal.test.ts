/**
 * An actor B refuses through spaceLinks.invoke says why and what to do
 * (task 01a1108a).
 *
 * B's resolve_actor (299) types its refusal `actor_not_permitted` with the
 * actor id. Through a link that is an actor the caller named itself (`--as`;
 * the home actor is already dropped), so the invoke re-types it with the link,
 * the target Space and the way out, and the link audit records
 * `actor_not_permitted` instead of a bare `forbidden`.
 *
 * No database: the store is a stub whose `use` hands back a link session, and
 * B's handler throws what db/errors.ts makes of the 299 RAISE.
 */
import { describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';

import type { DbClaims } from '../src/db/types.js';
import type { FacadeDeps } from '../src/facade/deps.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import {
  actorRefusalThroughLink, auditReasonOf, createSpaceLinkInvokeHandlers,
} from '../src/facade/handlers/w2/space-link-invoke.js';
import type { DbSpaceLinkStore, SpaceLinkAuditInput, SpaceLinkInvokeRow } from '../src/credentials/space-link-store.js';
import type { RequestContext } from '../src/http/types.js';

const HOME = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const HOME_ACTOR = '44444444-4444-4444-8444-444444444444';
const OTHER_ACTOR = '55555555-5555-4555-8555-555555555555';

function harness(run: (ctx: RequestContext) => Promise<unknown>) {
  const audits: SpaceLinkAuditInput[] = [];
  const row: SpaceLinkInvokeRow = {
    linkId: LINK, tokenRowId: 'row-1', memberId: 'member-h', homeSpaceId: HOME, targetSpaceId: TARGET,
    targetServerId: null, status: 'signed_in', allowSpawn: true, spawnBudget: 3,
  };
  const store = {
    resolveInvoke: async () => row,
    recordAudit: async (_claims: DbClaims, entry: SpaceLinkAuditInput) => { audits.push(entry); return `audit-${audits.length}`; },
    use: async () => ({
      token: 'link-token',
      session: {
        sessionId: 'link-session', accountId: 'account-b', identityId: 'identity-b', username: 'h', displayName: null,
        isNodeAdmin: false, isOwner: false, kind: 'link', actingAsTeamMemberId: null, workSessionId: null,
        runtimeMemberId: null, runtimeThreadRootId: null, runtimeChatId: null, spaceId: TARGET, viaLinkId: LINK,
        expiresAt: '2027-01-01T00:00:00Z', label: null,
      },
    }),
  } as unknown as DbSpaceLinkStore;
  const registry = new HandlerRegistry();
  registry.register('entities.create', run);
  const { invoke } = createSpaceLinkInvokeHandlers(
    registry, { config: {} } as unknown as FacadeDeps, store, async () => ({ identityId: 'identity-g' }) as DbClaims,
  );
  const create = (actorId?: string) => invoke({
    params: { spaceId: HOME, link: 'b' },
    body: {
      op: 'entities.create',
      input: { clientMutationId: 'cm-1', spaceId: TARGET, kind: 'doc', title: 't', ...(actorId ? { actorId } : {}) },
    },
    headers: {}, query: new URLSearchParams(),
    identity: { kind: 'bearer', authKind: 'agent', actorId: HOME_ACTOR, workSessionId: 'ws-g' },
  } as unknown as RequestContext) as Promise<unknown>;
  return { create, audits };
}

/** What B's resolve_actor (299) raises for an actor the link session may not act as, through db/errors.ts. */
const actorNotPermitted = (actorId: string) => new CollabError('forbidden', 'not permitted to act as this actor', {
  details: { sqlstate: '42501', reason: 'actor_not_permitted', actorId, spaceId: TARGET },
});

describe('spaceLinks.invoke — an actor B refuses says why and what to do (task 01a1108a)', () => {
  it('an explicit actorId B refuses: re-typed with the link, the target and "drop --as"; audited actor_not_permitted', async () => {
    const h = harness(async () => { throw actorNotPermitted(OTHER_ACTOR); });
    const error: unknown = await h.create(OTHER_ACTOR).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({
      code: 'forbidden',
      details: { sqlstate: '42501', reason: 'actor_not_permitted', actorId: OTHER_ACTOR, linkId: LINK, targetSpaceId: TARGET },
    });
    expect((error as Error).message).toContain(`space link ${LINK}`);
    expect((error as Error).message).toContain(`space ${TARGET}`);
    expect((error as Error).message).toContain('drop --as');
    expect(h.audits.at(-1)).toMatchObject({ op: 'entities.create', result: 'error', reason: 'actor_not_permitted', remoteId: null });
  });

  it('any other forbidden from B stands as B raised it, audited by code', async () => {
    const other = new CollabError('forbidden', 'no', { details: { sqlstate: '42501' } });
    const h = harness(async () => { throw other; });
    await expect(h.create()).rejects.toBe(other);
    expect(h.audits.at(-1)).toMatchObject({ result: 'error', reason: 'forbidden' });
  });

  it('auditReasonOf: a closed details.reason for every error, else the code; never free text', () => {
    expect(auditReasonOf(actorNotPermitted(OTHER_ACTOR))).toBe('actor_not_permitted');
    expect(auditReasonOf(new CollabError('conflict', 'x', { details: { reason: 'op_request_executing' } }))).toBe('op_request_executing');
    expect(auditReasonOf(new CollabError('forbidden', 'x', { details: { reason: 'Not A Reason!' } }))).toBe('forbidden');
    expect(auditReasonOf(new CollabError('not_found', 'x'))).toBe('not_found');
    expect(auditReasonOf(new Error('boom'))).toBe('internal');
  });

  it('actorRefusalThroughLink: null without a row, or for any other refusal', () => {
    expect(actorRefusalThroughLink(actorNotPermitted(OTHER_ACTOR), null)).toBeNull();
    expect(actorRefusalThroughLink(new CollabError('forbidden', 'x', { details: { reason: 'no_actor' } }), {
      linkId: LINK, targetSpaceId: TARGET,
    } as SpaceLinkInvokeRow)).toBeNull();
  });
});
