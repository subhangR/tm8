// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { EntityDetail } from '@tm8/contract';
import type { HttpClient, RequestOptions } from '../data/real/http';
import { fixtureDetails, taskUuidTitle, docLayoutSpec } from '../fixtures/entities';
import { collectPlan, executeTransfer, provenanceBody, type TransferPlan } from './engine';
import { connectedPeersOf } from './TransferDialog';

/**
 * The engine is exercised against FAKE catalog clients — the whole point of
 * taking `HttpClient` as a dependency is that these tests reach zero network
 * by construction, exactly like the transport's own tests.
 */

const rootDetail = fixtureDetails[taskUuidTitle.id] as EntityDetail;
const docDetail = fixtureDetails[docLayoutSpec.id] as EntityDetail;

const childDetail: EntityDetail = {
  ...rootDetail,
  id: 'task-child-1',
  title: 'Child task',
  version: 2,
  content: { kind: 'task', description: 'child work', acceptanceCriteria: [], pointsEstimate: null },
  hierarchy: { parent: taskUuidTitle, children: { items: [] }, path: [] },
  connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
};

type Call = { op: string; opts: RequestOptions };

function fakeClient(answer: (op: string, opts: RequestOptions) => unknown, calls?: Call[]): HttpClient {
  return {
    baseUrl: '',
    call: <T,>(op: string, opts: RequestOptions = {}) => {
      calls?.push({ op, opts });
      const result = answer(op, opts);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result as T);
    },
    callBytes: () => Promise.reject(new Error('not in this test')),
    callPath: () => Promise.reject(new Error('not in this test')),
    putGrantedBytes: () => Promise.reject(new Error('not in this test')),
  } as HttpClient;
}

function sourceAnswer(op: string, opts: RequestOptions): unknown {
  if (op === 'entities.children') {
    const id = opts.params?.id;
    return { items: id === rootDetail.id ? [{ ...taskUuidTitle, id: childDetail.id, title: childDetail.title }] : [] };
  }
  if (op === 'entities.get') {
    const id = opts.params?.id;
    if (id === childDetail.id) return childDetail;
    if (id === docLayoutSpec.id) return docDetail;
    if (id === 'commit-x') return { ...childDetail, id: 'commit-x', kind: 'commit', title: 'a commit' };
    return new Error(`no fixture for ${String(id)}`);
  }
  if (op === 'messages.list') {
    if (opts.params?.anchorId !== rootDetail.id) return { items: [] };
    return {
      items: [
        { id: 'm2', createdAt: '2026-07-28T11:00:00Z', createdBy: { displayName: 'Noor' }, content: { body: 'second' } },
        { id: 'm1', createdAt: '2026-07-28T10:00:00Z', createdBy: { displayName: 'Ada' }, content: { body: 'first' } },
      ],
    };
  }
  return new Error(`unexpected source op ${op}`);
}

const source = { client: fakeClient(sourceAnswer), serverId: 'srv-a', label: 'srv-a' };

async function planFixture(): Promise<TransferPlan> {
  return collectPlan(source, rootDetail, {
    includeChildren: true,
    connectedIds: [docLayoutSpec.id, 'commit-x'],
    includeMessages: true,
  });
}

describe('connectedPeersOf', () => {
  it('lists each distinct peer once and marks untransferable kinds', () => {
    const peers = connectedPeersOf(rootDetail);
    const byId = new Map(peers.map((p) => [p.id, p]));
    expect(byId.get(docLayoutSpec.id)?.transferable).toBe(true);
    const kinds = peers.map((p) => p.kind);
    expect(kinds).toContain('pull_request');
    expect(peers.find((p) => p.kind === 'pull_request')?.transferable).toBe(false);
    expect(peers.some((p) => p.id === rootDetail.id)).toBe(false);
  });
});

describe('collectPlan', () => {
  it('walks children, keeps ticked peers, and drops boundary-crossing edges', async () => {
    const plan = await planFixture();

    expect(plan.entities.map((e) => e.sourceId)).toEqual([rootDetail.id, childDetail.id, docLayoutSpec.id]);
    expect(plan.entities[0]?.role).toBe('root');
    expect(plan.entities[1]?.parentSourceId).toBe(rootDetail.id);
    expect(plan.entities[2]?.role).toBe('connected');

    // commit-x was ticked but its kind cannot be created on any destination.
    expect(plan.skipped.map((s) => s.id)).toEqual(['commit-x']);

    // Root's fixture edges reach taskBlocked / a PR / a commit — none in the
    // plan — and one `references` edge from the doc that IS in the plan.
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0]).toMatchObject({ type: 'references', srcSourceId: docLayoutSpec.id, dstSourceId: rootDetail.id });

    // Messages arrive oldest-first regardless of wire order.
    expect(plan.messages.map((m) => m.author)).toEqual(['Ada', 'Noor']);

    // Task content is projected for create: attribution-free criteria, no axes.
    const content = plan.entities[0]?.content as Record<string, unknown>;
    const criteria = content.acceptanceCriteria as Record<string, unknown>[];
    expect(criteria.some((c) => 'doneBy' in c || 'doneAt' in c)).toBe(false);
    expect(content).not.toHaveProperty('axes');
    expect(content.pointsEstimate).toBe(8);
  });

  it('refuses a root kind outside the transferable set', async () => {
    const session = { ...rootDetail, kind: 'work_session' } as EntityDetail;
    await expect(collectPlan(source, session, { includeChildren: false, connectedIds: [], includeMessages: false }))
      .rejects.toThrow(/cannot be transferred/);
  });
});

describe('executeTransfer', () => {
  it('creates parent-first with mapped parents, replayable mutation ids, edges and provenance', async () => {
    const plan = await planFixture();
    const calls: Call[] = [];
    let n = 0;
    const dest = fakeClient((op) => {
      if (op === 'entities.create') return { entity: { id: `dest-${(n += 1)}` } };
      if (op === 'edges.create' || op === 'messages.post') return {};
      return new Error(`unexpected dest op ${op}`);
    }, calls);

    const result = await executeTransfer(plan, { client: dest, spaceId: 'sp-dest' }, undefined);

    const creates = calls.filter((c) => c.op === 'entities.create').map((c) => c.opts.body as Record<string, unknown>);
    expect(creates).toHaveLength(3);
    expect(creates[0]).toMatchObject({ spaceId: 'sp-dest', kind: 'task', parentId: null });
    expect(creates[0]?.clientMutationId).toBe(plan.entities[0]?.mutationId);
    expect(creates[1]?.parentId).toBe('dest-1');
    expect(creates[2]?.parentId).toBeNull();

    const edges = calls.filter((c) => c.op === 'edges.create').map((c) => c.opts.body as Record<string, unknown>);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ srcId: 'dest-3', dstId: 'dest-1', type: 'references' });

    const posts = calls.filter((c) => c.op === 'messages.post').map((c) => c.opts.body as Record<string, unknown>);
    // Two copied messages plus the provenance receipt, all anchored on copies.
    expect(posts).toHaveLength(3);
    expect(posts[0]?.body).toMatch(/^\*\*Ada\*\* · /);
    const receipt = posts[2]?.body as string;
    expect(receipt).toContain('Transferred from server "srv-a"');
    expect(receipt).toContain(rootDetail.id);
    expect(receipt).toContain(`v${rootDetail.version}`);
    expect(posts[2]?.anchorIds).toEqual(['dest-1']);

    expect(result.destRootId).toBe('dest-1');
    expect(result.created).toHaveLength(3);
    expect(result.edgesCreated).toBe(1);
    expect(result.messagesPosted).toBe(2);
  });

  it('aborts on a failed root but only skips descendants on a failed child', async () => {
    const plan = await planFixture();

    const rootFails = fakeClient((op) => (op === 'entities.create' ? new Error('refused') : {}));
    const aborted = await executeTransfer(plan, { client: rootFails, spaceId: 'sp' }, undefined);
    expect(aborted.destRootId).toBeNull();
    expect(aborted.created).toHaveLength(0);

    let n = 0;
    const childFails = fakeClient((op, opts) => {
      if (op === 'entities.create') {
        const body = opts.body as Record<string, unknown>;
        if (body.title === 'Child task') return new Error('child refused');
        return { entity: { id: `dest-${(n += 1)}` } };
      }
      return {};
    });
    const partial = await executeTransfer(plan, { client: childFails, spaceId: 'sp' }, undefined);
    expect(partial.destRootId).toBe('dest-1');
    expect(partial.failedEntities.map((f) => f.title)).toEqual(['Child task']);
    // The connected doc is a sibling, not a descendant of the failed child.
    expect(partial.created.map((c) => c.title)).toContain(docLayoutSpec.title);
  });
});

describe('provenanceBody', () => {
  it('names the source server, entity, version and honesty clause', async () => {
    const plan = await planFixture();
    const body = provenanceBody(plan, { entities: 3, edges: 1, messages: 2 });
    expect(body).toContain('srv-a');
    expect(body).toContain('does not stay in sync');
    expect(body).toContain('3 entities, 1 edge, 2 messages');
  });
});
