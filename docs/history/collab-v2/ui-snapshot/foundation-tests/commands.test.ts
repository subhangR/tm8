/**
 * G0 contract tests — COMMANDS. Every command mutates the world correctly:
 * version bumps, activity bumps, counters, blocked rollups, staleness, awards,
 * unblock ripple, undo tokens, typed errors, idempotency.
 */
import { describe, expect, it } from 'vitest';
import { CollabError, isCollabError } from '../../types/contract';
import { createRig } from './helpers';

describe('createTask / patchTask', () => {
  it('creates a task with an atomic attach edge and activity', async () => {
    const { facade, ids } = createRig();
    const res = await facade.createTask({
      spaceId: ids.space, title: 'T-109 · Perf pass', description: 'Budget the interactions.',
      parentId: ids.t100, axes: { type: 'test' }, priority: 'low',
      attachTo: { entityId: ids.chBuild, edgeType: 'attached_to' },
      actorId: ids.subhang, clientMutationId: 'cmid-create-1',
    });
    expect(res.entity?.kind).toBe('task');
    expect(res.entity?.version).toBe(1);
    expect(res.edge?.type).toBe('attached_to');
    expect(res.edge?.target.id).toBe(ids.chBuild);
    expect(res.activity?.verb).toBe('created');
    expect(res.patches.map((p) => p.id)).toEqual(expect.arrayContaining([ids.chBuild, ids.t100]));
    const tabs = await facade.getChannelTabs(ids.chBuild);
    expect(tabs.find((t) => t.key === 'tasks')?.count).toBe(3);
  });

  it('replays identically for a duplicate clientMutationId (idempotency)', async () => {
    const { facade, ids } = createRig();
    const input = { spaceId: ids.space, title: 'Once only', actorId: ids.subhang, clientMutationId: 'cmid-dup' };
    const first = await facade.createTask(input);
    const second = await facade.createTask(input);
    expect(second.entity?.id).toBe(first.entity?.id);
    const tasks = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'] });
    expect(tasks.page.items.filter((i) => i.title === 'Once only')).toHaveLength(1);
  });

  it('content edits bump version + snapshot; workStatus alone does not', async () => {
    const { facade, ids } = createRig();
    await facade.patchTask(ids.t102, { expectedVersion: 1, description: 'RLS + agent attribution.', actorId: ids.mira });
    let detail = await facade.getEntity(ids.t102);
    expect(detail.version).toBe(2);
    await facade.patchTask(ids.t102, { expectedVersion: 2, workStatus: 'working', actorId: ids.mira });
    detail = await facade.getEntity(ids.t102);
    expect(detail.version).toBe(2); // status is a rollup, not versioned content
    if (detail.state.kind === 'task') expect(detail.state.workStatus).toBe('working');
    const versions = await facade.getVersions(ids.t102);
    expect(versions.items.map((v) => v.version)).toEqual([2, 1]);
  });

  it('rejects a stale expectedVersion with 409 + current detail', async () => {
    const { facade, ids } = createRig();
    try {
      await facade.patchTask(ids.t104, { expectedVersion: 99, title: 'nope', actorId: ids.mira });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isCollabError(e)).toBe(true);
      if (isCollabError(e)) {
        expect(e.code).toBe('version_conflict');
        expect(e.status).toBe(409);
        expect(e.current?.id).toBe(ids.t104);
        expect(e.current?.version).toBe(1);
      }
    }
  });
});

describe('move / hierarchy rules', () => {
  it('reparents within the same kind and rejects cross-kind or cycles', async () => {
    const { facade, ids } = createRig();
    const res = await facade.moveEntity(ids.t103b, { parentId: ids.t100, position: 99, expectedVersion: 1, actorId: ids.subhang });
    expect(res.entity?.parentId).toBe(ids.t100);
    await expect(facade.moveEntity(ids.docRollout, { parentId: ids.t100, position: 0, expectedVersion: 1, actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(facade.moveEntity(ids.t100, { parentId: ids.t103, position: 0, expectedVersion: 1, actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'invalid_input' }); // t103 is inside t100 → cycle
  });
});

describe('edges', () => {
  it('validates the registry and requires x:* namespacing for free-form types', async () => {
    const { facade, ids } = createRig();
    await expect(facade.createEdge({ srcId: ids.docSpec, dstId: ids.mira, type: 'assigned_to', actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'invalid_input' }); // doc is not an assignable source
    await expect(facade.createEdge({ srcId: ids.t107, dstId: ids.docSpec, type: 'blessed_by', actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'invalid_input' }); // unregistered, not x:*
    const ok = await facade.createEdge({ srcId: ids.t107, dstId: ids.docSpec, type: 'x:blessed_by', actorId: ids.subhang });
    expect(ok.edge?.type).toBe('x:blessed_by');
  });

  it('prevents depends_on cycles and bumps activity on both endpoints', async () => {
    const { facade, ids } = createRig();
    await expect(facade.createEdge({ srcId: ids.t104, dstId: ids.t105, type: 'depends_on', actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'invalid_input' }); // t105 already depends on t104
    const before = (await facade.getEntity(ids.t108)).activityAt;
    const res = await facade.createEdge({ srcId: ids.t108, dstId: ids.t107, type: 'relates_to', actorId: ids.mira });
    expect(res.edge).toBeDefined();
    expect(Date.parse((await facade.getEntity(ids.t108)).activityAt)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  it('deleting a dependency edge clears the blocked rollup', async () => {
    const { facade, ids } = createRig();
    const t105 = await facade.getEntity(ids.t105);
    const dep = t105.connections.outgoing.find((g) => g.type === 'depends_on')?.edges[0];
    expect(dep).toBeDefined();
    await facade.deleteEdge(dep!.id, { actorId: ids.subhang });
    const after = await facade.getEntity(ids.t105);
    expect(after.badges.blocked).toBeUndefined();
  });
});

describe('placements (drag grammar) + undo', () => {
  it('attach: edge + optional embed message, fully undoable', async () => {
    const { facade, ids, events } = createRig();
    const res = await facade.placements({
      sourceId: ids.fileWireframes, targetId: ids.chDesign, intent: 'attach',
      embedMessage: 'Latest wireframes', actorId: ids.mira, clientMutationId: 'cmid-place-1',
    });
    expect(res.edge?.type).toBe('attached_to');
    expect(res.undo?.token).toBeTruthy();
    let tabs = await facade.getChannelTabs(ids.chDesign);
    expect(tabs.find((t) => t.key === 'docs')?.count).toBe(1);
    const feed = await facade.getMessages(ids.chDesign);
    expect(feed.items[0].content.body).toContain(`{{embed:${ids.fileWireframes}}}`);
    expect(events.some((e) => e.type === 'edge.upsert')).toBe(true);

    await facade.undo(res.undo!);
    tabs = await facade.getChannelTabs(ids.chDesign);
    expect(tabs.find((t) => t.key === 'docs')).toBeUndefined();
    // undo tokens are single-use
    await expect(facade.undo(res.undo!)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('assign works in either drag direction', async () => {
    const { facade, ids } = createRig();
    const res = await facade.placements({ sourceId: ids.mira, targetId: ids.t107, intent: 'assign', actorId: ids.subhang });
    expect(res.edge?.type).toBe('assigned_to');
    expect(res.edge?.source.id).toBe(ids.t107);
    expect(res.edge?.target.id).toBe(ids.mira);
    await facade.undo(res.undo!);
    const detail = await facade.getEntity(ids.t107);
    if (detail.state.kind === 'task') expect(detail.state.assignees).toHaveLength(0);
  });

  it('depend: target waits on dropped source; blocked rollup appears and undo clears it', async () => {
    const { facade, ids } = createRig();
    const res = await facade.placements({ sourceId: ids.t103a, targetId: ids.t108, intent: 'depend', actorId: ids.subhang });
    expect(res.edge?.type).toBe('depends_on');
    expect(res.edge?.source.id).toBe(ids.t108);
    expect(res.edge?.hard).toBe(true);
    let t108 = await facade.getEntity(ids.t108);
    expect(t108.badges.blocked?.waitingOn[0].id).toBe(ids.t103a);
    await facade.undo(res.undo!);
    t108 = await facade.getEntity(ids.t108);
    expect(t108.badges.blocked).toBeUndefined();
  });

  it('subtask: reparent with position restore on undo', async () => {
    const { facade, ids } = createRig();
    const before = await facade.getEntity(ids.t108);
    const res = await facade.placements({ sourceId: ids.t108, targetId: ids.t103, intent: 'subtask', actorId: ids.subhang });
    expect(res.entity?.parentId).toBe(ids.t103);
    await facade.undo(res.undo!);
    const after = await facade.getEntity(ids.t108);
    expect(after.parentId).toBe(ids.t100);
    expect(after.position).toBe(before.position);
  });

  it('embed: message into a composer target, undo tombstones it', async () => {
    const { facade, ids } = createRig();
    const res = await facade.placements({ sourceId: ids.pr248, targetId: ids.chGeneral, intent: 'embed', actorId: ids.subhang });
    const msgId = res.entity?.id as string;
    expect((await facade.getEntity(msgId)).content).toMatchObject({ kind: 'message' });
    await facade.undo(res.undo!);
    const summary = await facade.getEntity(msgId);
    expect(summary.deletedAt).not.toBeNull();
    expect(summary.title).toBe('(deleted message)');
  });
});

describe('messages', () => {
  it('post bumps anchor counters + activity; reply threads via hierarchy', async () => {
    const { facade, ids, clock } = createRig();
    const before = await facade.getEntity(ids.t106);
    clock.advanceMinutes(1);
    const root = await facade.postMessage({ anchorId: ids.t106, body: 'Margin threads verified.', actorId: ids.scout, clientMutationId: 'cmid-msg-1' });
    const after = await facade.getEntity(ids.t106);
    expect(after.counters.messages).toBe(before.counters.messages + 1);
    expect(Date.parse(after.activityAt)).toBeGreaterThan(Date.parse(before.activityAt));
    const reply = await facade.postMessage({
      anchorId: ids.t106, parentMessageId: root.entity!.id, body: 'Nice.', actorId: ids.subhang,
    });
    const view = await facade.getMessages(ids.t106);
    const rootView = view.items.find((m) => m.id === root.entity!.id);
    expect(rootView?.replyCount).toBe(1);
    expect(rootView?.replies?.items[0].id).toBe(reply.entity!.id);
    if (rootView?.replies?.items[0].state.kind === 'message') {
      expect(rootView.replies.items[0].state.rootMessageId).toBe(root.entity!.id);
    }
  });

  it('edit bumps message version + editedAt; only the author may edit', async () => {
    const { facade, ids } = createRig();
    await expect(facade.patchMessage(ids.forgeProgressMessage, { body: 'hijack', actorId: ids.mira }))
      .rejects.toMatchObject({ code: 'forbidden' });
    const res = await facade.patchMessage(ids.forgeProgressMessage, { body: 'Panel scaffolding in place (edited).', actorId: ids.forge });
    expect(res.entity?.version).toBe(2);
    if (res.entity?.state.kind === 'message') expect(res.entity.state.editedAt).not.toBeNull();
  });

  it('delete redacts to a tombstone and decrements the anchor counter', async () => {
    const { facade, ids } = createRig();
    const before = await facade.getEntity(ids.t104);
    await facade.deleteMessage(ids.forgeProgressMessage, { actorId: ids.forge });
    const after = await facade.getEntity(ids.t104);
    expect(after.counters.messages).toBe(before.counters.messages - 1);
    // the tombstone still anchors its replies in the thread
    const thread = await facade.getMessages(ids.t104);
    const tomb = thread.items.find((m) => m.id === ids.forgeProgressMessage);
    expect(tomb?.deletedAt).not.toBeNull();
    expect(tomb?.content.body).toBe('');
    expect(tomb?.replyCount).toBe(1);
  });
});

describe('reactions & points', () => {
  it('like/dislike are mutually exclusive; star is independent; unreact removes', async () => {
    const { facade, ids } = createRig();
    await facade.setReaction(ids.docRollout, { reaction: 'like', enabled: true, actorId: ids.subhang });
    let doc = await facade.getEntity(ids.docRollout);
    expect(doc.counters).toMatchObject({ likes: 1, dislikes: 0 });
    expect(doc.counters.viewerReaction).toBe('like');
    await facade.setReaction(ids.docRollout, { reaction: 'dislike', enabled: true, actorId: ids.subhang });
    doc = await facade.getEntity(ids.docRollout);
    expect(doc.counters).toMatchObject({ likes: 0, dislikes: 1 });
    await facade.setReaction(ids.docRollout, { reaction: 'star', enabled: true, actorId: ids.subhang });
    doc = await facade.getEntity(ids.docRollout);
    expect(doc.counters).toMatchObject({ dislikes: 1, stars: 1 });
    await facade.setReaction(ids.docRollout, { reaction: 'dislike', enabled: false, actorId: ids.subhang });
    doc = await facade.getEntity(ids.docRollout);
    expect(doc.counters.dislikes).toBe(0);
    // another actor's reaction does not change the viewer's own
    await facade.setReaction(ids.docRollout, { reaction: 'like', enabled: true, actorId: ids.mira });
    doc = await facade.getEntity(ids.docRollout);
    expect(doc.counters.likes).toBe(1);
    expect(doc.counters.viewerReaction).toBe('star');
  });

  it('points are an accumulating ledger with idempotent grants', async () => {
    const { facade, ids } = createRig();
    await facade.grantPoints(ids.t107, { amount: 5, reason: 'grant', actorId: ids.subhang, clientMutationId: 'cmid-pts' });
    await facade.grantPoints(ids.t107, { amount: 5, reason: 'grant', actorId: ids.subhang, clientMutationId: 'cmid-pts' });
    await facade.grantPoints(ids.t107, { amount: 3, reason: 'grant', actorId: ids.mira });
    const t107 = await facade.getEntity(ids.t107);
    expect(t107.counters.points).toBe(8); // 5 (deduped) + 3
    await expect(facade.grantPoints(ids.t107, { amount: 0, reason: 'grant', actorId: ids.mira }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('completion → award → leaderboard → unblock ripple', () => {
  it('runs the whole gamification transaction', async () => {
    const { facade, ids, events } = createRig();
    // criteria gate first
    await expect(facade.completeTask(ids.t104, { expectedVersion: 1, completerIds: [ids.forge], actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    const detail = await facade.getEntity(ids.t104);
    const criteria = detail.content.kind === 'task' ? detail.content.acceptanceCriteria : [];
    await facade.patchTask(ids.t104, {
      expectedVersion: 1, acceptanceCriteria: criteria.map((c) => ({ ...c, done: true })), actorId: ids.subhang,
    });
    events.length = 0;
    const res = await facade.completeTask(ids.t104, { expectedVersion: 2, completerIds: [ids.forge], actorId: ids.subhang });

    // task is done, working edges cleared, completed_by recorded
    if (res.entity?.state.kind === 'task') expect(res.entity.state.workStatus).toBe('done');
    expect(res.entity?.badges.workingActors).toBeUndefined();
    const completedBy = res.entity?.connections.outgoing.find((g) => g.type === 'completed_by');
    expect(completedBy?.edges[0].target.id).toBe(ids.forge);
    expect(completedBy?.edges[0].props.awardedPoints).toBe(20);

    // award hit the ledger and the leaderboard
    const board = await facade.getLeaderboard(ids.space);
    expect(board.items[0].actor.id).toBe(ids.forge);
    expect(board.items[0].score).toBe(35); // 15 (T-101) + 20 (T-104 pool)
    const awards = await facade.getAwards(ids.space);
    expect(awards.items[0].ref?.id).toBe(ids.t104);

    // unblock ripple: T-105 blocked badge cleared + notification + patch event
    const t105 = await facade.getEntity(ids.t105);
    expect(t105.badges.blocked).toBeUndefined();
    const inbox = await facade.getInbox();
    expect(inbox.items.some((n) => n.kind === 'unblock' && n.target?.id === ids.t105)).toBe(true);
    expect(events.some((e) => e.type === 'entity.upsert' && e.entity.id === ids.t105)).toBe(true);
    expect(events.some((e) => e.type === 'notification.created')).toBe(true);

    // second completion is refused (award idempotency; DEV-8 invariant code)
    await expect(facade.completeTask(ids.t104, { expectedVersion: 2, completerIds: [ids.forge], actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'invariant_violation', status: 409 });
    // T-105 became ready to pull
    const ready = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'], filters: { readyToPull: true } });
    expect(ready.page.items.map((i) => i.id)).toContain(ids.t105);
  });
});

describe('pull, staleness, work status', () => {
  it('pull pins a version; a content edit flips contentStale and notifies', async () => {
    const { facade, ids } = createRig();
    const res = await facade.pullEntity(ids.docUiContract, { localId: 'local_uic', pinnedVersion: 1, actorId: ids.scout });
    expect(res.entity?.badges.pulls?.[0]).toMatchObject({ pinnedVersion: 1, contentStale: false });
    await facade.patchEntity(ids.docUiContract, {
      expectedVersion: 1, actorId: ids.mira, content: { body: '## UI Contract v2 — panels never blank-flash.' },
    });
    const doc = await facade.getEntity(ids.docUiContract);
    const pull = doc.badges.pulls?.find((p) => p.actor.id === ids.scout);
    expect(pull?.contentStale).toBe(true);
    const inbox = await facade.getInbox(); // Scout's owner (the viewer) hears about it
    expect(inbox.items.some((n) => n.kind === 'stale' && n.target?.id === ids.docUiContract)).toBe(true);
    // re-pull at the new version clears staleness
    await facade.pullEntity(ids.docUiContract, { localId: 'local_uic', pinnedVersion: 2, actorId: ids.scout });
    const repulled = await facade.getEntity(ids.docUiContract);
    expect(repulled.badges.pulls?.find((p) => p.actor.id === ids.scout)?.contentStale).toBe(false);
  });

  it('discussionMoved flips when activity happens after the pull', async () => {
    const { facade, ids, clock } = createRig();
    await facade.pullEntity(ids.t107, { pinnedVersion: 1, actorId: ids.probe });
    let t107 = await facade.getEntity(ids.t107);
    expect(t107.badges.pulls?.[0].discussionMoved).toBe(false);
    clock.advanceMinutes(2);
    await facade.postMessage({ anchorId: ids.t107, body: 'Scoreboard sketch attached.', actorId: ids.mira });
    t107 = await facade.getEntity(ids.t107);
    expect(t107.badges.pulls?.[0].discussionMoved).toBe(true);
  });

  it('first pull transitions an open task; setWork drives working_on edges', async () => {
    const { facade, ids } = createRig();
    await facade.pullEntity(ids.t103a, { pinnedVersion: 1, actorId: ids.probe });
    let t = await facade.getEntity(ids.t103a);
    if (t.state.kind === 'task') expect(t.state.workStatus).toBe('pulled');
    await facade.setWork(ids.t103a, { status: 'working', note: 'reads first', actorId: ids.probe });
    t = await facade.getEntity(ids.t103a);
    if (t.state.kind === 'task') expect(t.state.workStatus).toBe('working');
    expect(t.badges.workingActors?.[0].actor.id).toBe(ids.probe);
    expect(t.badges.pulls?.[0].workStatus).toBe('working'); // pull edge kept in sync
    await facade.setWork(ids.t103a, { status: 'in_review', actorId: ids.probe });
    t = await facade.getEntity(ids.t103a);
    expect(t.badges.workingActors).toBeUndefined();
    const inbox = await facade.getInbox();
    expect(inbox.items.some((n) => n.kind === 'review_request' && n.target?.id === ids.t103a)).toBe(true);
    await expect(facade.setWork(ids.t103a, { status: 'done', actorId: ids.probe }))
      .rejects.toMatchObject({ code: 'invariant_violation' }); // completion is transactional
  });
});

describe('tracking, read-marks, axes, saved views', () => {
  it('trackingRefresh clears PR fetch staleness', async () => {
    const { facade, ids, clock } = createRig();
    clock.advanceMinutes(20);
    let pr = await facade.getEntity(ids.pr248);
    if (pr.state.kind === 'pull_request') expect(pr.state.stale).toBe(true);
    await facade.trackingRefresh({ entityIds: [ids.pr248] });
    pr = await facade.getEntity(ids.pr248);
    if (pr.state.kind === 'pull_request') expect(pr.state.stale).toBe(false);
    await expect(facade.trackingRefresh({ entityIds: [ids.docSpec] }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('markRead zeroes unread; notification read-marks stick', async () => {
    const { facade, ids, clock } = createRig();
    clock.advanceMinutes(1);
    await facade.postMessage({ anchorId: ids.chBuild, body: 'One more thing…', actorId: ids.mira });
    let nav = await facade.getNavigation(ids.space);
    expect(nav.unreadTotal).toBe(2);
    clock.advanceMinutes(1);
    await facade.markRead(ids.chBuild, { actorId: ids.subhang });
    nav = await facade.getNavigation(ids.space);
    expect(nav.unreadTotal).toBe(0);
    const inbox = await facade.getInbox();
    const target = inbox.items[0];
    await facade.markNotificationRead(target.id);
    const after = await facade.getInbox();
    expect(after.items.find((n) => n.id === target.id)?.readAt).not.toBeNull();
  });

  it('task-axis admin: create/update/delete with guards', async () => {
    const { facade, ids } = createRig();
    const axis = await facade.createTaskAxis(ids.space, { name: 'platform', axisValues: ['web', 'mobile'], kind: 'manual', position: 2 });
    expect(axis.name).toBe('platform');
    await expect(facade.createTaskAxis(ids.space, { name: 'platform', axisValues: [], kind: 'manual', position: 3 }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    const updated = await facade.updateTaskAxis(ids.space, axis.id, { axisValues: ['web', 'mobile', 'cli'] });
    expect(updated.axisValues).toHaveLength(3);
    const axes = await facade.getTaskAxes(ids.space);
    const defaultAxis = axes.find((a) => a.kind === 'default');
    await expect(facade.deleteTaskAxis(ids.space, defaultAxis!.id)).rejects.toMatchObject({ code: 'forbidden' });
    await facade.deleteTaskAxis(ids.space, axis.id);
    expect((await facade.getTaskAxes(ids.space)).map((a) => a.name)).not.toContain('platform');
  });

  it('saved views: create/update/delete + private visibility', async () => {
    const { facade, ids } = createRig();
    const view = await facade.createSavedView(ids.space, {
      name: 'My blocked', shareMode: 'private',
      query: { spaceId: ids.space, kinds: ['task'], filters: { workStatus: ['blocked'] } },
      actorId: ids.subhang,
    });
    expect((await facade.listSavedViews(ids.space)).map((v) => v.id)).toContain(view.id);
    const renamed = await facade.updateSavedView(view.id, { name: 'Blocked (mine)' });
    expect(renamed.name).toBe('Blocked (mine)');
    await facade.deleteSavedView(view.id);
    expect((await facade.listSavedViews(ids.space)).map((v) => v.id)).not.toContain(view.id);
  });
});

describe('error injection & typed errors', () => {
  it('failNextWith rejects exactly one command', async () => {
    const { facade, ids } = createRig();
    facade.failNextWith(new CollabError('forbidden', 'injected'));
    await expect(facade.grantPoints(ids.t107, { amount: 1, reason: 'grant', actorId: ids.subhang }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(facade.grantPoints(ids.t107, { amount: 1, reason: 'grant', actorId: ids.subhang }))
      .resolves.toBeDefined();
  });

  it('not_found for missing and deleted entities', async () => {
    const { facade, ids } = createRig();
    await expect(facade.getEntity('ent_nope')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await facade.deleteEntity(ids.t108, { actorId: ids.subhang });
    await expect(facade.postMessage({ anchorId: ids.t108, body: 'ghost', actorId: ids.mira }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});
