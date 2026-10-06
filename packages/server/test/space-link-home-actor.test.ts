/**
 * A write through spaceLinks.invoke does not carry the caller's HOME actor
 * into B.
 *
 * A session's CLI stamps `actorId` = its own team member (in A) on every
 * write. B's `resolve_actor` cannot authorize that id for the link session,
 * so `tm8 --space <B> entity create doc …` was refused in B with "not
 * permitted to act as this actor" (audit: entities.create, error, forbidden,
 * no remote id). The executor drops the home actor; B resolves the actor
 * from the link session, i.e. the launching member. Any other actorId still
 * reaches B, which authorizes it as before.
 *
 * No database: the store is a stub whose `use` hands back a link session.
 */
import { describe, expect, it, vi } from 'vitest';
import { CollabError } from '@tm8/contract';

import type { DbClaims } from '../src/db/types.js';
import type { FacadeDeps } from '../src/facade/deps.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import {
  actorRefusalThroughLink, auditReasonOf, createSpaceLinkInvokeHandlers, withoutHomeActor,
} from '../src/facade/handlers/w2/space-link-invoke.js';
import type { DbSpaceLinkStore, SpaceLinkAuditInput, SpaceLinkInvokeRow } from '../src/credentials/space-link-store.js';
import type { RequestContext } from '../src/http/types.js';

const HOME = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const HOME_ACTOR = '44444444-4444-4444-8444-444444444444';
const OTHER_ACTOR = '55555555-5555-4555-8555-555555555555';
const CREATED = '66666666-6666-4666-8666-666666666666';

function harness(run: (ctx: RequestContext) => Promise<unknown> = async () => ({ entity: { id: CREATED } })) {
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
  const handler = vi.fn(run);
  registry.register('entities.create', handler);
  const { invoke } = createSpaceLinkInvokeHandlers(
    registry, { config: {} } as unknown as FacadeDeps, store, async () => ({ identityId: 'identity-g' }) as DbClaims,
  );
  const create = (actorId?: string) => invoke({
    params: { spaceId: HOME, link: 'b' },
    body: {
      op: 'entities.create',
      input: {
        clientMutationId: 'cm-1', spaceId: TARGET, kind: 'doc', title: 'Attention + Channels',
        content: { body: 'x' }, ...(actorId ? { actorId } : {}),
      },
    },
    headers: {}, query: new URLSearchParams(),
    identity: { kind: 'bearer', authKind: 'agent', actorId: HOME_ACTOR, workSessionId: 'ws-g' },
  } as unknown as RequestContext) as Promise<{ result: unknown }>;
  const innerBody = () => handler.mock.calls.at(-1)?.[0].body as Record<string, unknown>;
  return { create, audits, handler, innerBody };
}

describe('spaceLinks.invoke — the home actor stays home', () => {
  it('entities.create with the caller\'s home actorId runs in B without it, audited ok with the remote id', async () => {
    const h = harness();
    const out = await h.create(HOME_ACTOR);
    expect(out.result).toEqual({ entity: { id: CREATED } });
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.innerBody()).not.toHaveProperty('actorId');
    expect(h.innerBody()).toMatchObject({ spaceId: TARGET, kind: 'doc', title: 'Attention + Channels' });
    expect(h.audits.at(-1)).toMatchObject({ op: 'entities.create', result: 'ok', remoteId: CREATED });
  });

  it('a different actorId is not the home actor: it reaches B for B to authorize', async () => {
    const h = harness();
    await h.create(OTHER_ACTOR);
    expect(h.innerBody()).toMatchObject({ actorId: OTHER_ACTOR });
  });

  it('no actorId: unchanged', async () => {
    const h = harness();
    await h.create();
    expect(h.innerBody()).not.toHaveProperty('actorId');
  });

  it('withoutHomeActor leaves non-objects and callers without an actor alone', () => {
    expect(withoutHomeActor(undefined, HOME_ACTOR)).toBeUndefined();
    expect(withoutHomeActor([HOME_ACTOR], HOME_ACTOR)).toEqual([HOME_ACTOR]);
    expect(withoutHomeActor({ actorId: HOME_ACTOR }, undefined)).toEqual({ actorId: HOME_ACTOR });
    expect(withoutHomeActor({ actorId: HOME_ACTOR.toUpperCase(), a: 1 }, HOME_ACTOR)).toEqual({ a: 1 });
  });
});

/** What B's resolve_actor (299) raises for an actor the link session may not act as, through db/errors.ts. */
const actorNotPermitted = (actorId: string) => new CollabError('forbidden', 'not permitted to act as this actor', {
  details: { sqlstate: '42501', reason: 'actor_not_permitted', actorId, spaceId: TARGET },
});

describe('spaceLinks.invoke — an actor B refuses says why and what to do (task 01a1108a)', () => {
  it('an explicit actorId B refuses: re-typed with the link, the target and "drop --as"; audited forbidden.actor_not_permitted', async () => {
    const h = harness(async () => { throw actorNotPermitted(OTHER_ACTOR); });
    const error = await h.create(OTHER_ACTOR).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({
      code: 'forbidden',
      details: { sqlstate: '42501', reason: 'actor_not_permitted', actorId: OTHER_ACTOR, linkId: LINK, targetSpaceId: TARGET },
    });
    expect((error as Error).message).toContain(`space link ${LINK}`);
    expect((error as Error).message).toContain(`space ${TARGET}`);
    expect((error as Error).message).toContain('drop --as');
    expect(h.audits.at(-1)).toMatchObject({ op: 'entities.create', result: 'error', reason: 'forbidden.actor_not_permitted', remoteId: null });
  });

  it('any other forbidden from B stands as B raised it, audited by code', async () => {
    const other = new CollabError('forbidden', 'no', { details: { sqlstate: '42501' } });
    const h = harness(async () => { throw other; });
    await expect(h.create()).rejects.toBe(other);
    expect(h.audits.at(-1)).toMatchObject({ result: 'error', reason: 'forbidden' });
  });

  it('auditReasonOf: code, plus a closed details.reason; never free text', () => {
    expect(auditReasonOf(actorNotPermitted(OTHER_ACTOR))).toBe('forbidden.actor_not_permitted');
    expect(auditReasonOf(new CollabError('conflict', 'x', { details: { reason: 'op_request_executing' } }))).toBe('conflict.op_request_executing');
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
