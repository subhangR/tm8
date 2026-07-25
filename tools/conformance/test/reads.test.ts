/**
 * Ported from the UI foundation `contract-reads` suite (R21): every read
 * returns contract-shaped data. The seeded MockFacade world is replaced by a
 * world built through the public API (src/world.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ActivityItemSchema, EntityDetailSchema, EntitySummarySchema, HomeSnapshotSchema,
  LeaderboardRowSchema, MessageViewSchema, NotificationItemSchema, pageOf,
  SpaceNavigationSchema, SpaceSettingsSchema, SpaceSummarySchema, TaskAxisSchema,
  type EntityDetail, type SpaceNavigation,
} from '@tm8/contract';
import { api, expectError } from '../src/client.js';
import { buildWorld, expectValid, type World } from '../src/world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld('reads');
});

describe('spaces & navigation', () => {
  it('lists spaces as SpaceSummary rows including the built world', async () => {
    const rows = expectValid(SpaceSummarySchema.array(), await api.read('spaces.list'), 'spaces.list');
    expect(rows.some((s) => s.id === w.spaceId)).toBe(true);
  });

  it('navigation carries the viewer and the channel tree', async () => {
    const nav = expectValid<SpaceNavigation>(SpaceNavigationSchema, await api.read('spaces.navigation', { spaceId: w.spaceId }), 'spaces.navigation');
    expect(nav.viewer.isAgent).toBe(false);
    const titles = nav.channels.map((c) => c.entity.title);
    expect(titles).toEqual(expect.arrayContaining(['general', 'build']));
  });
});

describe('entity detail (Z3/Z4 shape)', () => {
  it('task detail: content, hierarchy, connections, capabilities are contract-shaped', async () => {
    const t101 = expectValid<EntityDetail>(EntityDetailSchema, await api.read('entities.get', { id: w.t101 }), 'entities.get t101');
    expect(t101.kind).toBe('task');
    expect(t101.hierarchy.parent?.id).toBe(w.epic);
    expect(t101.hierarchy.path.map((p) => p.id)).toContain(w.epic);
    const outTypes = t101.connections.outgoing.map((g) => g.type);
    expect(outTypes).toEqual(expect.arrayContaining(['assigned_to', 'attached_to']));
    expect(outTypes).not.toContain('likes'); // reactions never appear as connections
    expect(t101.capabilities.canComplete).toBe(true);
    if (t101.state.kind === 'task') {
      expect(t101.state.assignees.map((a) => a.id)).toContain(w.forge);
      expect(t101.state.acceptance.total).toBe(2);
    }
    // Deliberately NOT points: `grant_points` (007:1577) refuses anything that
    // is not a member or team_member — points are earned by someone, and a
    // task cannot earn anything. This asserted 5 points on a TASK, which the
    // schema forbids, so it could never pass. The world builder grants them to
    // the persona, and that is where the assertion belongs.
    expect(t101.counters.points).toBe(0);
    expect(t101.counters.messages).toBe(1);
  });

  it('blocked rollup: t103 waits on t102 (hard dep)', async () => {
    const t103 = expectValid<EntityDetail>(EntityDetailSchema, await api.read('entities.get', { id: w.t103 }), 'entities.get t103');
    expect(t103.badges.blocked?.unresolvedHardDependencyCount).toBe(1);
    expect(t103.badges.blocked?.waitingOn[0]?.id).toBe(w.t102);
    expect(t103.connections.unresolvedHardDependencyCount).toBe(1);
    const dep = t103.connections.outgoing.find((g) => g.type === 'depends_on')?.edges[0];
    expect(dep?.hard).toBe(true);
    expect(dep?.resolved).toBe(false);
  });

  it('channel detail derives auto-tabs from attached_to; tab queries resolve', async () => {
    const hub = expectValid<EntityDetail>(EntityDetailSchema, await api.read('entities.get', { id: w.chBuild }), 'entities.get build');
    if (hub.content.kind !== 'channel') throw new Error('expected channel content');
    const byKey = Object.fromEntries(hub.content.autoTabs.map((t) => [t.key, t]));
    expect(hub.content.autoTabs[0]?.key).toBe('feed');
    expect(byKey.tasks?.count).toBe(1); // t101
    expect(byKey.docs?.count).toBe(1);  // spec doc
    const resolved = await api.command('collections.query', byKey.tasks!.query) as { page: { items: { id: string }[] } };
    expect(resolved.page.items.map((i) => i.id)).toContain(w.t101);
  });

  it('lazy sections: activity and versions are contract-shaped pages', async () => {
    const activity = expectValid(pageOf(ActivityItemSchema), await api.read('entities.activity', { id: w.t101 }), 'entities.activity');
    expect(activity.items.length).toBeGreaterThan(0);
    const versions = await api.read('entities.versions', { id: w.docSpec }) as { items: { version: number }[] };
    expect(versions.items.length).toBeGreaterThan(0);
  });
});

describe('collections & threads', () => {
  it('every created kind returns schema-valid summaries', async () => {
    for (const kind of ['channel', 'task', 'doc', 'team_member', 'member'] as const) {
      const res = await api.command('collections.query', { spaceId: w.spaceId, kinds: [kind] }) as { page: { items: unknown[] } };
      expect(res.page.items.length, `kind ${kind}`).toBeGreaterThan(0);
      for (const item of res.page.items) expectValid(EntitySummarySchema, item, `summary ${kind}`);
    }
  });

  it('groupBy workStatus and axis grouping', async () => {
    const board = await api.command('collections.query', {
      spaceId: w.spaceId, kinds: ['task'], subtreeOf: w.epic, groupBy: 'workStatus', sort: 'position',
    }) as { groups?: { key: string }[] };
    expect(board.groups?.map((g) => g.key)).toEqual(expect.arrayContaining(['open']));
    const byAxis = await api.command('collections.query', {
      spaceId: w.spaceId, kinds: ['task'], subtreeOf: w.epic, groupBy: 'axis:type',
    }) as { groups?: { key: string }[] };
    expect(byAxis.groups?.map((g) => g.key)).toEqual(expect.arrayContaining(['code', 'design']));
  });

  it('readyToPull excludes blocked tasks', async () => {
    const ready = await api.command('collections.query', {
      spaceId: w.spaceId, kinds: ['task'], filters: { readyToPull: true },
    }) as { page: { items: { id: string }[] } };
    const ids = ready.page.items.map((i) => i.id);
    expect(ids).not.toContain(w.t103); // blocked on t102
    expect(ids).toContain(w.t104);
  });

  it('threads return MessageView pages', async () => {
    const roots = expectValid(pageOf(MessageViewSchema), await api.read('messages.list', { anchorId: w.t101 }), 'messages.list');
    expect(roots.items.some((m) => m.id === w.rootMessage)).toBe(true);
  });

  it('home, inbox, leaderboard, axes, settings are contract-shaped', async () => {
    expectValid(HomeSnapshotSchema, await api.read('spaces.home', { spaceId: w.spaceId }), 'spaces.home');
    expectValid(pageOf(NotificationItemSchema), await api.read('inbox.list'), 'inbox.list');
    expectValid(pageOf(LeaderboardRowSchema), await api.read('spaces.leaderboard', { spaceId: w.spaceId }), 'spaces.leaderboard');
    const axes = await api.read('spaces.taskAxes.list', { spaceId: w.spaceId }) as unknown[];
    for (const a of axes) expectValid(TaskAxisSchema, a, 'task axis');
    expectValid(SpaceSettingsSchema, await api.read('spaces.settings', { spaceId: w.spaceId }), 'spaces.settings');
  });

  it('lists exclude soft-deleted entities by default; deleted:"only" surfaces tombstones', async () => {
    await api.command('entities.delete', {}, { id: w.t104 });
    const tasks = await api.command('collections.query', { spaceId: w.spaceId, kinds: ['task'], subtreeOf: w.epic }) as { page: { items: { id: string }[] } };
    expect(tasks.page.items.map((i) => i.id)).not.toContain(w.t104);
    const only = await api.command('collections.query', { spaceId: w.spaceId, kinds: ['task'], filters: { deleted: 'only' } }) as { page: { items: { id: string; deletedAt: string | null }[] } };
    const tomb = only.page.items.find((i) => i.id === w.t104);
    expect(tomb?.deletedAt).not.toBeNull();
    await api.command('entities.restore', {}, { id: w.t104 });
  });

  it('missing and tombstoned ids are not_found', async () => {
    await expectError(api.read('entities.get', { id: 'ent_nope' }), 'not_found');
  });
});
