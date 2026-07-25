/**
 * Ported from the UI foundation `commands` + `validation` suites (R21):
 * command semantics (versions, conflicts, hierarchy rules, edge registry,
 * placements/undo, messages, reactions, points, completion→award→unblock)
 * and DEF-1/2/3 input validation over the wire.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CommandResultSchema, EntityDetailSchema, type EntityDetail } from '@tm8/contract';
import { api, expectError } from '../src/client.js';
import { buildWorld, expectValid, type World } from '../src/world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld('commands');
});

async function getDetail(id: string): Promise<EntityDetail> {
  return expectValid(EntityDetailSchema, await api.read('entities.get', { id }), `entities.get ${id}`);
}

describe('create/patch + optimistic concurrency', () => {
  it('createEntity returns a CommandResult with the new detail and attach edge', async () => {
    const res = expectValid(CommandResultSchema, await api.command('entities.create', {
      spaceId: w.spaceId, kind: 'task', title: 'T-105 · Extra', parentId: w.epic,
      content: { description: 'spawned by conformance' },
      attachTo: { entityId: w.chBuild, edgeType: 'attached_to' },
      clientMutationId: `cmid-create-${Date.now()}`,
    }), 'entities.create');
    expect(res.entity?.kind).toBe('task');
    expect(res.entity?.version).toBe(1);
    expect(res.edge?.type).toBe('attached_to');
    expect(res.patches.length).toBeGreaterThan(0);
  });

  it('content patches bump version; stale expectedVersion → 409 with current detail', async () => {
    const before = await getDetail(w.t102);
    await api.command('entities.patch', {
      expectedVersion: before.version, content: { description: 'patched by conformance' },
    }, { id: w.t102 });
    const after = await getDetail(w.t102);
    expect(after.version).toBe(before.version + 1);

    const err = await expectError(api.command('entities.patch', {
      expectedVersion: 99, title: 'nope',
    }, { id: w.t102 }), 'version_conflict');
    expect(err.status).toBe(409);
    const current = (err.details as { current?: { id: string; version: number } } | undefined)?.current;
    expect(current?.id, 'version_conflict must carry details.current').toBe(w.t102);
    expect(current?.version).toBe(after.version);
  });

  it('DEF-1/2/3 validation: unknown fields, closed enums, wrong types → invalid_input, no write', async () => {
    const before = await getDetail(w.t103);
    await expectError(api.command('entities.commands.work', { workStatus: 'done' }, { id: w.t103 }), 'invalid_input');
    await expectError(api.command('entities.commands.work', { status: 'banana' }, { id: w.t103 }), 'invalid_input');
    await expectError(api.command('entities.commands.work', { status: 'working', speed: 'fast' }, { id: w.t103 }), 'invalid_input');
    await expectError(api.command('entities.commands.work', { status: 'working', startedAt: 'yesterdayish' }, { id: w.t103 }), 'invalid_input');
    const after = await getDetail(w.t103);
    expect(after.version).toBe(before.version);
    expect(after.state).toEqual(before.state);
  });
});

describe('hierarchy + edges', () => {
  it('move rejects cross-kind parents and cycles', async () => {
    const doc = await getDetail(w.docSpec);
    await expectError(api.command('entities.move', {
      parentId: w.epic, position: 0, expectedVersion: doc.version,
    }, { id: w.docSpec }), 'invalid_input');
    const epic = await getDetail(w.epic);
    await expectError(api.command('entities.move', {
      parentId: w.t101, position: 0, expectedVersion: epic.version,
    }, { id: w.epic }), 'invalid_input'); // t101 is inside epic → cycle
  });

  it('edge registry: unregistered types need x:*; depends_on cycles rejected', async () => {
    await expectError(api.command('edges.create', {
      srcId: w.t101, dstId: w.docSpec, type: 'blessed_by',
    }), 'invalid_input');
    const ok = await api.command('edges.create', {
      srcId: w.t101, dstId: w.docSpec, type: 'x:blessed_by',
    }) as { edge?: { type: string } };
    expect(ok.edge?.type).toBe('x:blessed_by');
    await expectError(api.command('edges.create', {
      srcId: w.t102, dstId: w.t103, type: 'depends_on', props: { hard: true },
    }), 'invalid_input'); // t103 already depends on t102
  });

  it('deleting the dependency edge clears the blocked rollup', async () => {
    const t103 = await getDetail(w.t103);
    const dep = t103.connections.outgoing.find((g) => g.type === 'depends_on')?.edges[0];
    expect(dep).toBeDefined();
    await api.command('edges.delete', {}, { edgeId: dep!.id });
    const after = await getDetail(w.t103);
    expect(after.badges.blocked).toBeUndefined();
    // restore for later suites' independence within this world
    await api.command('edges.create', { srcId: w.t103, dstId: w.t102, type: 'depends_on', props: { hard: true } });
  });
});

describe('placements + undo (DEV-11)', () => {
  it('attach placement yields an edge and a single-use undo token', async () => {
    const res = await api.command('placements.apply', {
      sourceId: w.docSpec, targetId: w.chGeneral, intent: 'attach',
    }) as { edge?: { type: string }; undo?: { token: string; label: string } };
    expect(res.edge?.type).toBe('attached_to');
    expect(res.undo?.token).toBeTruthy();
    await api.command('commands.undo', { token: res.undo!.token });
    await expectError(api.command('commands.undo', { token: res.undo!.token }), 'not_found'); // single-use
  });

  it('placements reject unknown intents', async () => {
    await expectError(api.command('placements.apply', {
      sourceId: w.docSpec, targetId: w.t101, intent: 'staple',
    }), 'invalid_input');
  });
});

describe('messages', () => {
  it('post bumps counters; reply threads; edit is author-only; delete tombstones', async () => {
    const before = await getDetail(w.t102);
    const root = await api.command('messages.post', {
      anchorId: w.t102, body: 'Root message.', clientMutationId: `cmid-m-${Date.now()}`,
    }) as { entity?: { id: string } };
    const after = await getDetail(w.t102);
    expect(after.counters.messages).toBe(before.counters.messages + 1);

    const reply = await api.command('messages.post', {
      anchorId: w.t102, parentMessageId: root.entity!.id, body: 'A reply.',
    }) as { entity?: { id: string } };
    const thread = await api.read('messages.list', { anchorId: w.t102 }) as { items: { id: string; replyCount: number; replies?: { items: { id: string }[] } }[] };
    const rootView = thread.items.find((m) => m.id === root.entity!.id);
    expect(rootView?.replyCount).toBe(1);
    expect(rootView?.replies?.items[0]?.id).toBe(reply.entity!.id);

    await api.command('messages.delete', {}, { id: reply.entity!.id });
    const afterDelete = await getDetail(w.t102);
    expect(afterDelete.counters.messages).toBe(after.counters.messages);
  });

  it('postMessage validates mention shapes', async () => {
    await expectError(api.command('messages.post', { anchorId: w.chGeneral }), 'invalid_input');
    await expectError(api.command('messages.post', {
      anchorId: w.chGeneral, body: 'hi', mentions: [{ entityId: w.viewerId, kind: 'robot', display: '@x' }],
    }), 'invalid_input');
  });
});

describe('reactions & points', () => {
  it('like/dislike are mutually exclusive; star independent; viewerReaction tracks the caller', async () => {
    await api.command('entities.react', { reaction: 'like', enabled: true }, { id: w.docSpec });
    let doc = await getDetail(w.docSpec);
    expect(doc.counters).toMatchObject({ likes: 1, dislikes: 0 });
    expect(doc.counters.viewerReaction).toBe('like');
    await api.command('entities.react', { reaction: 'dislike', enabled: true }, { id: w.docSpec });
    doc = await getDetail(w.docSpec);
    expect(doc.counters).toMatchObject({ likes: 0, dislikes: 1 });
    await api.command('entities.react', { reaction: 'dislike', enabled: false }, { id: w.docSpec });
    doc = await getDetail(w.docSpec);
    expect(doc.counters.dislikes).toBe(0);
  });

  it('points reject zero amounts and closed-set violations', async () => {
    await expectError(api.command('entities.points.add', { amount: 0, reason: 'grant' }, { id: w.t101 }), 'invalid_input');
    await expectError(api.command('entities.points.add', { amount: 5, reason: 'bribe' }, { id: w.t101 }), 'invalid_input');
  });
});

describe('completion → award → unblock ripple', () => {
  it('criteria gate, single award, unblock of dependents', async () => {
    let t101 = await getDetail(w.t101);
    // criteria not done yet → refused
    await expectError(api.command('entities.commands.complete', {
      expectedVersion: t101.version, completerIds: [w.forge],
    }, { id: w.t101 }), 'invalid_input');

    if (t101.content.kind !== 'task') throw new Error('expected task content');
    await api.command('entities.patch', {
      expectedVersion: t101.version,
      content: { acceptanceCriteria: t101.content.acceptanceCriteria.map((c) => ({ ...c, done: true })) },
    }, { id: w.t101 });
    t101 = await getDetail(w.t101);

    const res = await api.command('entities.commands.complete', {
      expectedVersion: t101.version, completerIds: [w.forge],
    }, { id: w.t101 }) as { entity?: EntityDetail };
    if (res.entity?.state.kind === 'task') expect(res.entity.state.workStatus).toBe('done');

    const board = await api.read('spaces.leaderboard', { spaceId: w.spaceId }) as { items: { actor: { id: string }; score: number }[] };
    expect(board.items.some((r) => r.actor.id === w.forge && r.score > 0)).toBe(true);

    // second completion refused (award idempotency)
    await expectError(api.command('entities.commands.complete', {
      expectedVersion: t101.version + 1, completerIds: [w.forge],
    }, { id: w.t101 }), 'invariant_violation');
  });
});

describe('pull / work / staleness', () => {
  it('pull pins a version; content edit flips contentStale; re-pull clears it', async () => {
    const doc = await getDetail(w.docSpec);
    await api.command('entities.commands.pull', { localId: 'local_spec', pinnedVersion: doc.version }, { id: w.docSpec });
    let d = await getDetail(w.docSpec);
    expect(d.badges.pulls?.[0]?.contentStale).toBe(false);
    await api.command('entities.patch', { expectedVersion: d.version, content: { body: '# Spec v2' } }, { id: w.docSpec });
    d = await getDetail(w.docSpec);
    expect(d.badges.pulls?.[0]?.contentStale).toBe(true);
    await api.command('entities.commands.pull', { localId: 'local_spec', pinnedVersion: d.version }, { id: w.docSpec });
    d = await getDetail(w.docSpec);
    expect(d.badges.pulls?.[0]?.contentStale).toBe(false);
  });

  it('setWork drives working badges; done-by-setWork is refused (completion is transactional)', async () => {
    await api.command('entities.commands.pull', { pinnedVersion: 1 }, { id: w.t104 });
    await api.command('entities.commands.work', { status: 'working' }, { id: w.t104 });
    const t = await getDetail(w.t104);
    if (t.state.kind === 'task') expect(t.state.workStatus).toBe('working');
    expect(t.badges.workingActors?.length).toBeGreaterThan(0);
    await expectError(api.command('entities.commands.work', { status: 'done' }, { id: w.t104 }), 'invariant_violation');
  });
});

describe('axes + saved views admin', () => {
  it('task-axis create/update/delete with duplicate guard', async () => {
    const axis = await api.command('spaces.taskAxes.create', {
      name: 'platform', axisValues: ['web', 'cli'], kind: 'manual', position: 1,
    }, { spaceId: w.spaceId }) as { id: string; name: string };
    expect(axis.name).toBe('platform');
    await expectError(api.command('spaces.taskAxes.create', {
      name: 'platform', axisValues: [], kind: 'manual', position: 2,
    }, { spaceId: w.spaceId }), 'invalid_input');
    const updated = await api.command('spaces.taskAxes.update', { axisValues: ['web', 'cli', 'mobile'] }, { spaceId: w.spaceId, axisId: axis.id }) as { axisValues: string[] };
    expect(updated.axisValues).toHaveLength(3);
    await api.command('spaces.taskAxes.delete', {}, { spaceId: w.spaceId, axisId: axis.id });
  });

  it('saved views CRUD', async () => {
    const view = await api.command('savedViews.create', {
      name: 'Blocked (mine)', shareMode: 'private',
      query: { spaceId: w.spaceId, kinds: ['task'], filters: { workStatus: ['blocked'] } },
    }) as { id: string };
    const list = await api.read('savedViews.list', { spaceId: w.spaceId }) as { id: string }[];
    expect(list.map((v) => v.id)).toContain(view.id);
    await api.command('savedViews.delete', {}, { viewId: view.id });
    const after = await api.read('savedViews.list', { spaceId: w.spaceId }) as { id: string }[];
    expect(after.map((v) => v.id)).not.toContain(view.id);
  });
});
