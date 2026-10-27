/**
 * L3 — `entities.refs.add`'s server half (279): D7 is refused before anything
 * runs on B, and the target is read THROUGH the caller's link (one
 * `spaceLinks.invoke` of `entities.get`) before the snapshot is stored. The
 * SQL half is test/db/cross-space-refs.pg.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { CROSS_SPACE_REF_LINK_INACTIVE, CROSS_SPACE_REF_NO_LINK, CollabError } from '@tm8/contract';

import type { DbSpaceLinkStore, SpaceLinkInvokeRow } from '../src/credentials/space-link-store.js';
import type { FacadeDeps } from '../src/facade/deps.js';
import { createCrossSpaceRefHandlers } from '../src/facade/handlers/w2/cross-space-refs.js';
import type { OperationHandler, RequestContext } from '../src/http/types.js';

const A = '0f1e2d3c-0000-4000-8000-00000000000a';
const B = '0f1e2d3c-0000-4000-8000-00000000000b';
const ENTITY = '0f1e2d3c-0000-4000-8000-0000000000a1';
const TARGET = '0f1e2d3c-0000-4000-8000-0000000000b1';
const LINK = '0f1e2d3c-0000-4000-8000-000000000d01';

function row(status: SpaceLinkInvokeRow['status']): SpaceLinkInvokeRow {
  return {
    linkId: LINK, tokenRowId: 'tok', memberId: 'm', homeSpaceId: A, targetSpaceId: B,
    targetServerId: null, status, allowSpawn: false, spawnBudget: 0,
  };
}

function harness(opts: {
  resolve?: () => Promise<SpaceLinkInvokeRow>;
  target?: Record<string, unknown>;
}) {
  const rpc = vi.fn(async (_claims: unknown, fn: string, args: unknown[]) => ({ fn, args }));
  const query = vi.fn(async () => [{ space_id: A }]);
  const deps = { db: { rpc, query } } as unknown as FacadeDeps;
  const store = {
    resolveInvoke: vi.fn(opts.resolve ?? (async () => row('signed_in'))),
  } as unknown as DbSpaceLinkStore;
  const invoke = vi.fn(async (_ctx: RequestContext) => ({
    op: 'entities.get', linkId: LINK, targetSpaceId: B, auditId: 'audit',
    result: opts.target ?? { id: TARGET, spaceId: B, kind: 'task', title: 'Ship it' },
  })) as unknown as OperationHandler & ReturnType<typeof vi.fn>;
  const { add } = createCrossSpaceRefHandlers(deps, store, async () => ({ identityId: 'h' }) as never, invoke);
  const ctx = {
    params: { id: ENTITY },
    body: { link: 'research', targetEntityId: TARGET },
    headers: {},
    identity: {},
  } as unknown as RequestContext;
  return { add: () => add(ctx), rpc, invoke, store };
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await run();
  } catch (err) {
    if (err instanceof CollabError) return { code: err.code, reason: err.details?.['reason'] };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('entities.refs.add', () => {
  it('reads the target through the link, then stores its kind and title as the snapshot', async () => {
    const h = harness({});
    await h.add();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const inner = h.invoke.mock.calls[0]![0] as RequestContext;
    expect(inner.params).toEqual({ spaceId: A, link: LINK });
    expect(inner.body).toEqual({ op: 'entities.get', params: { id: TARGET } });
    expect(h.rpc).toHaveBeenCalledWith(expect.anything(), 'add_cross_space_ref', [ENTITY, LINK, TARGET, 'task', 'Ship it']);
  });

  it('D7: no link row is refused before anything runs on B', async () => {
    const h = harness({ resolve: async () => { throw new CollabError('not_found', 'space link not found'); } });
    expect(await refusal(h.add)).toEqual({ code: 'forbidden', reason: CROSS_SPACE_REF_NO_LINK });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('D7: a signed-out link is refused before anything runs on B', async () => {
    const h = harness({ resolve: async () => row('signed_out') });
    expect(await refusal(h.add)).toEqual({ code: 'forbidden', reason: CROSS_SPACE_REF_LINK_INACTIVE });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('a read that answers for another entity or space stores nothing', async () => {
    for (const target of [
      { id: ENTITY, spaceId: B, kind: 'task', title: 'x' },
      { id: TARGET, spaceId: A, kind: 'task', title: 'x' },
    ]) {
      const h = harness({ target });
      expect((await refusal(h.add)).code).toBe('not_found');
      expect(h.rpc).not.toHaveBeenCalled();
    }
  });
});
