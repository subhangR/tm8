/**
 * `tm8 --space <B> edge create <A-entity> <type> <B-entity>` through a link.
 *
 * Prod audit (task 01a1108a-398f): edges.create through a link failed 35
 * times with a bare invariant_violation ("edge endpoints must be in the same
 * space", write_edge's D3 check) and agents retried it in a loop. An edge
 * never crosses spaces; the supported pointer is a cross-space reference made
 * from HOME. The refusal now says so and names the exact command, oriented
 * from the caller's own space, with the link it just used.
 *
 * No database: the real edges.create handler runs in B over a fake Db that
 * answers each query under the claims it was given (B's link session sees
 * only B, the caller's home claims see only A).
 */
import { CROSS_SPACE_EDGE, CollabError } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../src/db/types.js';
import type { FacadeDeps } from '../src/facade/deps.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import { registerW2EdgesPlacementsHandlers } from '../src/facade/handlers/w2/edges-placements.js';
import { createSpaceLinkInvokeHandlers } from '../src/facade/handlers/w2/space-link-invoke.js';
import type { DbSpaceLinkStore, SpaceLinkAuditInput, SpaceLinkInvokeRow } from '../src/credentials/space-link-store.js';
import type { RequestContext } from '../src/http/types.js';

const HOME = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const A_TASK = '44444444-4444-4444-8444-444444444444';
const B_TASK = '55555555-5555-4555-8555-555555555555';
const OWNER = { identityId: 'owner', accountId: 'owner-account', username: 'owner', isNodeAdmin: false, isOwner: true };

/** One fake for both sides: what a query sees depends on whose claims ran it. */
class SplitDb implements Db {
  readonly rpcs: string[] = [];
  private visible(claims: DbClaims): Array<{ id: string; space_id: string }> {
    return claims.identityId === 'identity-b' ? [{ id: B_TASK, space_id: TARGET }] : [{ id: A_TASK, space_id: HOME }];
  }
  private run<R>(claims: DbClaims, params: readonly unknown[]): R[] {
    const ids = (params[0] ?? []) as string[];
    return this.visible(claims).filter((r) => ids.includes(r.id)) as R[];
  }
  tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: async <R>(_sql: string, params: readonly unknown[] = []) => this.run<R>(claims, params),
      rpc: async <U>(name: string, args: readonly unknown[] = []): Promise<U> => this.rpc<U>(claims, name, args),
    });
  }
  async query<R>(claims: DbClaims, _sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.run<R>(claims, params);
  }
  async rpc<T>(_claims: DbClaims, fn: string): Promise<T> {
    this.rpcs.push(fn);
    // write_edge's own refusal, as translateDbError delivers it.
    throw new CollabError('invariant_violation', 'edge endpoints must be in the same space', {
      details: { sqlstate: '23514' },
    });
  }
  async end(): Promise<void> {}
}

function harness() {
  const audits: SpaceLinkAuditInput[] = [];
  const row: SpaceLinkInvokeRow = {
    linkId: LINK, tokenRowId: 'row-1', memberId: 'member-h', homeSpaceId: HOME, targetSpaceId: TARGET,
    targetServerId: null, status: 'signed_in', allowSpawn: false, spawnBudget: 3,
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
  const db = new SplitDb();
  const deps = { db, config: {}, owner: async () => OWNER } as unknown as FacadeDeps;
  const registry = new HandlerRegistry();
  registerW2EdgesPlacementsHandlers(registry, deps);
  const { invoke } = createSpaceLinkInvokeHandlers(
    registry, deps, store, async () => ({ identityId: 'identity-g' }) as DbClaims,
  );
  const edge = (srcId: string, dstId: string) => invoke({
    params: { spaceId: HOME, link: LINK },
    body: { op: 'edges.create', input: { srcId, dstId, type: 'relates_to', clientMutationId: 'cm-edge' } },
    headers: {}, query: new URLSearchParams(),
    identity: { kind: 'bearer', authKind: 'agent', identityId: 'identity-g', workSessionId: 'ws-g' },
  } as unknown as RequestContext);
  return { edge, audits, db };
}

describe('spaceLinks.invoke edges.create between home and the linked space', () => {
  it('fails once with the exact ref command from home, the link it used, and a typed audit reason', async () => {
    const h = harness();
    const error = await h.edge(A_TASK, B_TASK).catch((e: unknown) => e) as CollabError;
    const next = `tm8 entity ref add ${A_TASK} ${B_TASK} --link ${LINK}`;
    expect(error).toBeInstanceOf(CollabError);
    expect(error.code).toBe('invariant_violation');
    expect(error.retryable).toBe(false);
    expect(error.details).toMatchObject({
      reason: CROSS_SPACE_EDGE, holderId: A_TASK, targetId: B_TASK, targetSpaceId: TARGET, linkId: LINK, next,
    });
    expect(error.message).toContain(next);
    expect(error.message).toContain('without --space');
    expect(h.db.rpcs).toEqual(['write_edge']);
    expect(h.audits.at(-1)).toMatchObject({ op: 'edges.create', result: 'error', reason: CROSS_SPACE_EDGE });
  });

  it('the B end given first: the reference is still held by home\'s entity', async () => {
    const h = harness();
    const error = await h.edge(B_TASK, A_TASK).catch((e: unknown) => e) as CollabError;
    expect(error.details).toMatchObject({ holderId: A_TASK, targetId: B_TASK, next: `tm8 entity ref add ${A_TASK} ${B_TASK} --link ${LINK}` });
  });

  it('a short id through the link is named, never sent to B\'s SQL', async () => {
    const h = harness();
    await expect(h.edge(A_TASK, '55555555')).rejects.toMatchObject({
      code: 'not_found', details: { reason: 'edge_endpoint_not_uuid', field: 'dstId' },
    });
    expect(h.db.rpcs).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({ op: 'edges.create', result: 'error', reason: 'edge_endpoint_not_uuid' }); // #1054: the audit keeps details.reason
  });
});
