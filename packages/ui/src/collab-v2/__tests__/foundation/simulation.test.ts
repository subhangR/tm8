/**
 * G0 simulation tests — the scripted driver replays the golden narrative as
 * real WorkspaceEvents: progress message, spec v5 → stale pin, review request,
 * criteria check, completion → award → leaderboard → unblock ripple, wrap-up.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSimulation } from '../../mock';
import { connectStores, useGraphStore, usePresenceStore } from '../../stores';
import { createRig } from './helpers';

beforeEach(() => {
  useGraphStore.getState().reset();
  usePresenceStore.getState().reset();
});

describe('simulation driver', () => {
  it('replays the golden narrative end-to-end with real semantics', async () => {
    const { facade, ids, events, presenceEvents, clock } = createRig();
    const sim = createSimulation(facade);
    const executed: string[] = [];
    while (!sim.done) {
      clock.advanceMinutes(1);
      const name = await sim.step();
      if (name) executed.push(name);
    }
    expect(executed).toEqual([
      'mira-typing',
      'forge-posts-progress',
      'mira-bumps-spec-to-v5',
      'scout-requests-review',
      'subhang-checks-last-criterion',
      'complete-t104-award-unblock',
      'forge-announces-ship',
    ]);
    expect(sim.done).toBe(true);
    expect(await sim.step()).toBeNull(); // idempotent past the end

    // spec doc reached v5 and Forge's pinned pull is now STALE
    const doc = await facade.getEntity(ids.docSpec);
    expect(doc.version).toBe(5);
    const forgePull = doc.badges.pulls?.find((p) => p.actor.id === ids.forge);
    expect(forgePull).toMatchObject({ pinnedVersion: 4, contentStale: true });
    const inbox = await facade.getInbox();
    expect(inbox.items.some((n) => n.kind === 'stale' && n.target?.id === ids.docSpec)).toBe(true);

    // review request landed as a mention notification on T-106
    expect(inbox.items.some((n) => n.kind === 'mention' && n.target?.id === ids.t106)).toBe(true);

    // completion: T-104 done, bounty awarded to Forge, leaderboard moved
    const t104 = await facade.getEntity(ids.t104);
    if (t104.state.kind === 'task') expect(t104.state.workStatus).toBe('done');
    expect(t104.state.kind === 'task' && t104.state.acceptance.completed).toBe(3);
    const board = await facade.getLeaderboard(ids.space);
    expect(board.items[0]).toMatchObject({ score: 35, rank: 1 }); // 15 + 20
    expect(board.items[0].actor.id).toBe(ids.forge);
    expect(inbox.items.some((n) => n.kind === 'award' && n.target?.id === ids.t104)).toBe(true);

    // unblock ripple: T-105's blocked badge cleared + notification
    const t105 = await facade.getEntity(ids.t105);
    expect(t105.badges.blocked).toBeUndefined();
    expect(inbox.items.some((n) => n.kind === 'unblock' && n.target?.id === ids.t105)).toBe(true);

    // the whole durable story arrived on the canonical stream (live layer fuel)
    const types = new Set(events.map((e) => e.type));
    for (const t of ['entity.upsert', 'edge.upsert', 'message.created', 'counter.changed',
      'activity.created', 'notification.created'] as const) {
      expect(types.has(t), `event type ${t}`).toBe(true);
    }
    // DEV-4: presence/typing NEVER ride the durable stream — they arrive on
    // the client-synthesized presence channel only.
    expect(types.has('presence.changed')).toBe(false);
    expect(types.has('typing.changed')).toBe(false);
    const presenceTypes = new Set(presenceEvents.map((e) => e.type));
    expect(presenceTypes.has('presence.changed')).toBe(true);
    expect(presenceTypes.has('typing.changed')).toBe(true);
    // ship announcement carries a live embed of the completed task
    const feed = await facade.getMessages(ids.chBuild);
    const shipMsg = feed.items[feed.items.length - 1];
    expect(shipMsg.content.body).toContain(`{{embed:${ids.t104}}}`);
  });

  it('feeds the stores end-to-end (staleness + board move visible client-side)', async () => {
    const { facade, ids, clock } = createRig();
    const unsubscribe = connectStores(facade, ids.space);
    const seedTasks = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'], subtreeOf: ids.t100 });
    useGraphStore.getState().ingestSummaries(seedTasks.page.items);
    useGraphStore.getState().ingestSummaries([await facade.getEntity(ids.docSpec)]);

    const sim = createSimulation(facade);
    while (!sim.done) { clock.advanceMinutes(1); await sim.step(); }

    const s = useGraphStore.getState();
    expect(s.entities[ids.docSpec].version).toBe(5);
    expect(s.entities[ids.docSpec].badges.pulls?.some((p) => p.contentStale)).toBe(true);
    const t104 = s.entities[ids.t104];
    expect(t104.state.kind === 'task' && t104.state.workStatus).toBe('done');
    expect(s.entities[ids.t105].badges.blocked).toBeUndefined();
    expect(s.notifications.some((n) => n.kind === 'unblock')).toBe(true);
    expect(usePresenceStore.getState().byEntity[ids.chBuild]?.viewers.map((v) => v.id)).toEqual([ids.forge]);
    unsubscribe();
  });

  it('skips a raced step instead of wedging (resilience)', async () => {
    const { facade, ids, clock } = createRig();
    const sim = createSimulation(facade);
    // A user completes T-104 out from under the script:
    const detail = await facade.getEntity(ids.t104);
    const criteria = detail.content.kind === 'task' ? detail.content.acceptanceCriteria : [];
    await facade.patchTask(ids.t104, { expectedVersion: 1, acceptanceCriteria: criteria.map((c) => ({ ...c, done: true })), actorId: ids.subhang });
    await facade.completeTask(ids.t104, { expectedVersion: 2, completerIds: [ids.mira], actorId: ids.subhang });
    while (!sim.done) { clock.advanceMinutes(1); await sim.step(); }
    // Script's own completion was refused (already done) but the loop finished.
    expect(sim.done).toBe(true);
    const t104 = await facade.getEntity(ids.t104);
    if (t104.state.kind === 'task') expect(t104.state.workStatus).toBe('done');
  });
});
