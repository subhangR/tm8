/**
 * G0.1 contract-reconciliation tests — one describe per deviation of
 * docs/history/collab-v2/api-design/05-COHERENCE-MATRIX.md §3 (DEV-1…13) that touches
 * the mock seam. DEV-2/6 are HTTP-level (no facade surface to test beyond the
 * interface comment); everything else is exercised here.
 */
import { describe, expect, it } from 'vitest';
import { CollabError } from '../../types/contract';
import { createRig } from './helpers';

describe('DEV-1 — generic create/patch carries tasks', () => {
  it('createEntity({ kind: "task" }) creates a real task from content fields', async () => {
    const { facade, ids } = createRig();
    const res = await facade.createEntity({
      spaceId: ids.space, kind: 'task', title: 'T-200 · Generic-created',
      parentId: ids.t100,
      content: {
        description: 'Born through POST /v2/entities.',
        axes: { type: 'code' }, priority: 'high',
        acceptanceCriteria: [{ text: 'exists' }], pointsEstimate: 5,
      },
      actorId: ids.subhang,
    });
    expect(res.entity?.kind).toBe('task');
    if (res.entity?.state.kind === 'task') {
      expect(res.entity.state.priority).toBe('high');
      expect(res.entity.state.axes.type).toBe('code');
    }
    if (res.entity?.content.kind === 'task') {
      expect(res.entity.content.description).toContain('POST /v2/entities');
      expect(res.entity.content.pointsEstimate).toBe(5);
    }
    expect(res.entity?.parentId).toBe(ids.t100);
  });

  it('patchEntity patches a task with fields inside content (incl. workStatus rollup)', async () => {
    const { facade, ids } = createRig();
    const res = await facade.patchEntity(ids.t102, {
      expectedVersion: 1, actorId: ids.mira,
      content: { description: 'RLS + agent attribution.', workStatus: 'working' },
    });
    expect(res.entity?.version).toBe(2); // description is versioned content
    if (res.entity?.state.kind === 'task') expect(res.entity.state.workStatus).toBe('working');
    // status-only patch via the generic route does NOT bump version
    const res2 = await facade.patchEntity(ids.t102, {
      expectedVersion: 2, actorId: ids.mira, content: { workStatus: 'in_review' },
    });
    expect(res2.entity?.version).toBe(2);
  });

  it('replays identically across the wrapper and the generic form (one ledger op)', async () => {
    const { facade, ids } = createRig();
    const first = await facade.createTask({
      spaceId: ids.space, title: 'Create once', actorId: ids.subhang, clientMutationId: 'cmid-dev1',
    });
    const second = await facade.createEntity({
      spaceId: ids.space, kind: 'task', title: 'DIFFERENT TITLE IGNORED ON REPLAY',
      actorId: ids.subhang, clientMutationId: 'cmid-dev1',
    });
    expect(second.entity?.id).toBe(first.entity?.id);
    expect(second.entity?.title).toBe('Create once');
  });
});

describe('DEV-3 — linkPr command', () => {
  it('creates the pull_request entity + tracks edge atomically, PR in patches', async () => {
    const { facade, ids } = createRig();
    const url = 'https://github.com/subhang/agent-maestro/pull/300';
    const res = await facade.linkPr(ids.t105, { url, actorId: ids.forge, clientMutationId: 'cmid-linkpr' });
    expect(res.entity?.kind).toBe('pull_request');
    if (res.entity?.state.kind === 'pull_request') {
      expect(res.entity.state.repository).toBe('subhang/agent-maestro');
      expect(res.entity.state.number).toBe(300);
      expect(res.entity.state.stale).toBe(false);
    }
    expect(res.edge?.type).toBe('tracks');
    expect(res.edge?.source.id).toBe(ids.t105);
    expect(res.patches.map((p) => p.kind)).toContain('pull_request');
    // idempotent replay (DEV-9 applies here too)
    const replay = await facade.linkPr(ids.t105, { url, actorId: ids.forge, clientMutationId: 'cmid-linkpr' });
    expect(replay.entity?.id).toBe(res.entity?.id);
  });

  it('upserts by URL — a seeded PR is reused, never duplicated', async () => {
    const { facade, ids } = createRig();
    const before = await facade.queryCollection({ spaceId: ids.space, kinds: ['pull_request'] });
    const res = await facade.linkPr(ids.t103, {
      url: 'https://github.com/subhang/agent-maestro/pull/248', actorId: ids.subhang,
    });
    expect(res.entity?.id).toBe(ids.pr248);
    const after = await facade.queryCollection({ spaceId: ids.space, kinds: ['pull_request'] });
    expect(after.page.items.length).toBe(before.page.items.length);
    // and the edge landed
    const t103 = await facade.getEntity(ids.t103);
    const tracks = t103.connections.outgoing.find((g) => g.type === 'tracks');
    expect(tracks?.edges.some((e) => e.target.id === ids.pr248)).toBe(true);
  });

  it('rejects unparseable URLs and non-task sources', async () => {
    const { facade, ids } = createRig();
    await expect(facade.linkPr(ids.t105, { url: 'not-a-pr-url', actorId: ids.forge }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(facade.linkPr(ids.docSpec, {
      url: 'https://github.com/subhang/agent-maestro/pull/301', actorId: ids.forge,
    })).rejects.toMatchObject({ code: 'invalid_input' }); // tracks edges start at tasks
  });
});

describe('DEV-4 — presence never rides the durable stream', () => {
  it('setPresence emits only on the presence channel', async () => {
    const { facade, ids, events, presenceEvents } = createRig();
    events.length = 0;
    presenceEvents.length = 0;
    facade.withWorld((w) => w.setPresence(ids.chBuild, [ids.mira], [ids.mira]));
    expect(events).toHaveLength(0);
    expect(presenceEvents.map((e) => e.type)).toEqual(['presence.changed', 'typing.changed']);
  });
});

describe('DEV-5 — opaque keyset cursors', () => {
  it('rejects legacy offset cursors and garbage with invalid_cursor', async () => {
    const { facade, ids } = createRig();
    await expect(facade.queryCollection({ spaceId: ids.space, kinds: ['task'], cursor: 'off:4' }))
      .rejects.toMatchObject({ code: 'invalid_cursor', status: 400 });
    await expect(facade.getInbox('!!not-base64!!'))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(facade.getSpaceActivity(ids.space, 'b2ZmOjQ=')) // base64 of "off:4", wrong shape
      .rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('keyset resume neither skips nor duplicates under concurrent inserts', async () => {
    const { facade, ids, clock } = createRig();
    const page1 = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'], limit: 4 });
    // A new task lands at the TOP of activityAt_desc between the two pages —
    // an offset would shift the window and re-serve page-1 rows.
    clock.advanceMinutes(1);
    await facade.createTask({ spaceId: ids.space, title: 'Mid-pagination insert', actorId: ids.mira });
    const page2 = await facade.queryCollection({
      spaceId: ids.space, kinds: ['task'], limit: 4, cursor: page1.page.nextCursor as string,
    });
    const page1Ids = new Set(page1.page.items.map((i) => i.id));
    expect(page2.page.items.every((i) => !page1Ids.has(i.id))).toBe(true);
    expect(page2.page.items.map((i) => i.title)).not.toContain('Mid-pagination insert');
  });
});

describe('DEV-7 — reaction is PUT-semantics (singular reaction, enabled flag)', () => {
  it('setting the same reaction twice is a no-op, not a double count', async () => {
    const { facade, ids } = createRig();
    await facade.setReaction(ids.docRollout, { reaction: 'like', enabled: true, actorId: ids.subhang });
    await facade.setReaction(ids.docRollout, { reaction: 'like', enabled: true, actorId: ids.subhang });
    let doc = await facade.getEntity(ids.docRollout);
    expect(doc.counters.likes).toBe(1);
    await facade.setReaction(ids.docRollout, { reaction: 'like', enabled: false, actorId: ids.subhang });
    await facade.setReaction(ids.docRollout, { reaction: 'like', enabled: false, actorId: ids.subhang });
    doc = await facade.getEntity(ids.docRollout);
    expect(doc.counters.likes).toBe(0);
    expect(doc.counters.viewerReaction).toBeNull();
  });
});

describe('DEV-8 — extended error taxonomy', () => {
  it('maps every new code to its HTTP status with requestId + retryable', () => {
    expect(new CollabError('invalid_cursor', 'x')).toMatchObject({ status: 400, retryable: false });
    expect(new CollabError('invariant_violation', 'x')).toMatchObject({ status: 409, retryable: false });
    expect(new CollabError('payload_too_large', 'x')).toMatchObject({ status: 413, retryable: false });
    expect(new CollabError('rate_limited', 'x')).toMatchObject({ status: 429, retryable: true });
    expect(new CollabError('not_implemented', 'x')).toMatchObject({ status: 501, retryable: false });
    expect(new CollabError('upstream_unavailable', 'x')).toMatchObject({ status: 503, retryable: true });
    expect(new CollabError('forbidden', 'x').requestId).toMatch(/^req_/);
  });

  it('error injection produces contract-taxonomy failures', async () => {
    const { facade, ids } = createRig();
    facade.setErrorRate(1);
    await expect(facade.grantPoints(ids.t107, { amount: 1, reason: 'grant', actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'upstream_unavailable', status: 503, retryable: true });
    facade.setErrorRate(0);
    facade.failNextWith(new CollabError('rate_limited', 'slow down', { details: { retryAfterMs: 1000 } }));
    await expect(facade.grantPoints(ids.t107, { amount: 1, reason: 'grant', actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });
});

describe('DEV-9 — universal idempotency ledger', () => {
  it('honors clientMutationId on edge/message/read mutations, not just creates', async () => {
    const { facade, ids } = createRig();
    // deleteEdge replay: second call must NOT throw not_found
    const t105 = await facade.getEntity(ids.t105);
    const dep = t105.connections.outgoing.find((g) => g.type === 'depends_on')!.edges[0];
    const del1 = await facade.deleteEdge(dep.id, { actorId: ids.subhang, clientMutationId: 'cmid-edge-del' });
    const del2 = await facade.deleteEdge(dep.id, { actorId: ids.subhang, clientMutationId: 'cmid-edge-del' });
    expect(del2).toBe(del1);
    // patchMessage replay: version bumps once
    await facade.patchMessage(ids.forgeProgressMessage, { body: 'edit one', actorId: ids.forge, clientMutationId: 'cmid-msg-edit' });
    await facade.patchMessage(ids.forgeProgressMessage, { body: 'edit two IGNORED', actorId: ids.forge, clientMutationId: 'cmid-msg-edit' });
    const msg = await facade.getEntity(ids.forgeProgressMessage);
    expect(msg.version).toBe(2);
    if (msg.content.kind === 'message') expect(msg.content.body).toBe('edit one');
    // markRead + reaction replays are no-ops with the same result
    const r1 = await facade.markRead(ids.chBuild, { actorId: ids.subhang, clientMutationId: 'cmid-read' });
    const r2 = await facade.markRead(ids.chBuild, { actorId: ids.subhang, clientMutationId: 'cmid-read' });
    expect(r2).toBe(r1);
  });

  it('same id on a different operation is an invariant_violation (04 §5.1)', async () => {
    const { facade, ids } = createRig();
    await facade.grantPoints(ids.t107, { amount: 2, reason: 'grant', actorId: ids.subhang, clientMutationId: 'cmid-shared' });
    await expect(facade.setReaction(ids.t107, { reaction: 'like', enabled: true, actorId: ids.subhang, clientMutationId: 'cmid-shared' }))
      .rejects.toMatchObject({ code: 'invariant_violation' });
  });

  it('undo redemption is itself idempotent under a clientMutationId', async () => {
    const { facade, ids } = createRig();
    const placed = await facade.placements({ sourceId: ids.mira, targetId: ids.t107, intent: 'assign', actorId: ids.subhang });
    const u1 = await facade.undo(placed.undo!, { clientMutationId: 'cmid-undo' });
    const u2 = await facade.undo(placed.undo!, { clientMutationId: 'cmid-undo' }); // token gone, ledger answers
    expect(u2).toBe(u1);
  });
});

describe('DEV-10 — counters.viewerReaction is guaranteed', () => {
  it('is present (null, not undefined) with no reaction, and set when the viewer reacted', async () => {
    const { facade, ids, events } = createRig();
    const unreacted = await facade.getEntity(ids.t103);
    expect('viewerReaction' in unreacted.counters).toBe(true);
    expect(unreacted.counters.viewerReaction).toBeNull();
    const starred = await facade.getEntity(ids.docSpec); // seeded: Subhang starred it
    expect(starred.counters.viewerReaction).toBe('star');
    // counter.changed events carry it too
    events.length = 0;
    await facade.grantPoints(ids.t103, { amount: 1, reason: 'grant', actorId: ids.mira });
    const counterEvt = events.find((e) => e.type === 'counter.changed');
    expect(counterEvt && 'counters' in counterEvt && 'viewerReaction' in counterEvt.counters).toBe(true);
  });
});

describe('DEV-11 — undo token TTL (5 minutes, mock clock)', () => {
  it('redeems inside the TTL, expires after it with invariant_violation', async () => {
    const { facade, ids, clock } = createRig();
    const fresh = await facade.placements({ sourceId: ids.mira, targetId: ids.t107, intent: 'assign', actorId: ids.subhang });
    expect(fresh.undo?.expiresAt).toBeTruthy();
    clock.advanceMinutes(4);
    await expect(facade.undo(fresh.undo!)).resolves.toBeDefined(); // 4 min → still valid
    const stale = await facade.placements({ sourceId: ids.mira, targetId: ids.t108, intent: 'assign', actorId: ids.subhang });
    clock.advanceMinutes(6);
    await expect(facade.undo(stale.undo!)).rejects.toMatchObject({ code: 'invariant_violation', status: 409 });
    // expired token is consumed — a retry is not_found
    await expect(facade.undo(stale.undo!)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('DEV-13 — search deferred', () => {
  it('search rejects with a typed not_implemented and stays on the seam', async () => {
    const { facade, ids } = createRig();
    await expect(facade.search('anything', { spaceId: ids.space }))
      .rejects.toMatchObject({ code: 'not_implemented', status: 501, retryable: false });
    expect(typeof facade.search).toBe('function'); // v2 slot intact
  });
});
