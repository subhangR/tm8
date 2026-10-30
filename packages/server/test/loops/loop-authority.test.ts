/**
 * Bridges L (D26, D68): the bridge loop authority gate and the registry guard
 * it rides on. The door (`loop_request_approval`) is covered against Postgres
 * in loops-bridges.pg.test.ts; here the database is a fake at the rpc boundary.
 */
import { describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { LOOP_APPROVAL_GATED_OPERATIONS, loopAuthorityGuard } from '../../src/loops/authority.js';

const OWNER = { identityId: 'owner', isNodeAdmin: false } as never;

function ctxFor(workSessionId?: string, params: Record<string, string> = {}): RequestContext {
  return {
    params, query: new URLSearchParams(), body: {}, requestId: 'r-1',
    identity: { kind: 'bearer', identityId: 'owner', authKind: workSessionId ? 'agent' : 'cli', ...(workSessionId ? { workSessionId } : {}) },
  } as unknown as RequestContext;
}

function fakeDb(answer: unknown): { db: Db; calls: Array<{ fn: string; args: readonly unknown[] }> } {
  const calls: Array<{ fn: string; args: readonly unknown[] }> = [];
  const q = { rpc: async (fn: string, args: readonly unknown[]) => { calls.push({ fn, args }); return answer; }, query: async () => [] };
  return { db: { tx: async (_c: unknown, fn: (q: unknown) => Promise<unknown>) => fn(q) } as unknown as Db, calls };
}

describe('the gated list (D26)', () => {
  it('covers delete, PR merge, members, bridges and permissions, and none of the granted creates and edits', () => {
    for (const op of ['entities.delete', 'tracking.pr.merge', 'spaces.members.remove', 'bridges.update', 'bridges.remove',
      'spaceLinks.inbound.grant', 'node.pathGrants.create', 'messages.attachments.remove',
      'spaces.members.spacePassword.reset'] as const) {
      expect(LOOP_APPROVAL_GATED_OPERATIONS.has(op)).toBe(true);
    }
    for (const op of ['entities.create', 'entities.patch', 'messages.post', 'labels.create', 'collections.addItem',
      'collections.removeItem', 'edges.delete', 'entities.refs.remove', 'bridges.listen', 'bridges.handles.claim'] as const) {
      expect(LOOP_APPROVAL_GATED_OPERATIONS.has(op as never)).toBe(false);
    }
  });
});

describe('loopAuthorityGuard', () => {
  it('applies only to a gated operation called by a work session', () => {
    const { db } = fakeDb(null);
    const guard = loopAuthorityGuard({ db, owner: async () => OWNER });
    expect(guard.applies('tracking.pr.merge', ctxFor('s-1'))).toBe(true);
    expect(guard.applies('tracking.pr.merge', ctxFor())).toBe(false);
    expect(guard.applies('entities.create', ctxFor('s-1'))).toBe(false);
  });

  it('refuses approval_required and raises the request when the session runs under a bridge loop', async () => {
    const { db, calls } = fakeDb({ requestId: 'att-1', created: true, loopId: 'loop-1', ownerMemberId: 'm-1' });
    const guard = loopAuthorityGuard({ db, owner: async () => OWNER });
    const err = await guard.check('tracking.pr.merge', ctxFor('s-1', { id: 'pr-9' })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CollabError);
    expect(err).toMatchObject({ code: 'forbidden', details: { reason: 'approval_required', loopId: 'loop-1', requestId: 'att-1' } });
    expect(calls).toEqual([{ fn: 'loop_request_approval', args: ['s-1', 'tracking.pr.merge', 'tracking.pr.merge pr-9'] }]);
  });

  it('lets every other session through', async () => {
    const { db } = fakeDb(null);
    await expect(loopAuthorityGuard({ db, owner: async () => OWNER }).check('entities.delete', ctxFor('s-2'))).resolves.toBeUndefined();
  });
});

describe('HandlerRegistry guards', () => {
  it('runs an applying guard before the handler, and a refusal stops it', async () => {
    let ran = 0;
    const registry = new HandlerRegistry().register('entities.delete', async () => { ran += 1; return { ok: true }; });
    registry.addGuard({
      applies: (_name, ctx) => ctx.identity.workSessionId === 'blocked',
      check: async () => { throw new CollabError('forbidden', 'needs approval'); },
    });
    const handler = registry.get('entities.delete')!;
    await expect(Promise.resolve(handler(ctxFor('blocked')))).rejects.toMatchObject({ code: 'forbidden' });
    expect(ran).toBe(0);
    await expect(Promise.resolve(handler(ctxFor('free')))).resolves.toEqual({ ok: true });
    expect(ran).toBe(1);
  });
});
