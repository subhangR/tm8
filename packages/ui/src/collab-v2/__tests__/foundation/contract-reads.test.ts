/**
 * G0 contract tests — READS. Every read returns contract-shaped data and the
 * seed world carries the full narrative: all 11 kinds, every core edge type,
 * blocked rollups, pull pins, auto-tabs, unread, home presets, leaderboard.
 */
import { describe, expect, it } from 'vitest';
import type { EntityKind, EntitySummary } from '../../types/contract';
import { ISO_RE, createRig } from './helpers';

function expectSummaryShape(s: EntitySummary): void {
  expect(typeof s.id).toBe('string');
  expect(typeof s.spaceId).toBe('string');
  expect(typeof s.title).toBe('string');
  expect(s.title).not.toBe('');
  expect(typeof s.position).toBe('number');
  expect(typeof s.version).toBe('number');
  expect(s.activityAt).toMatch(ISO_RE);
  expect(s.createdAt).toMatch(ISO_RE);
  expect(s.updatedAt).toMatch(ISO_RE);
  expect(['space', 'restricted']).toContain(s.visibility);
  expect(typeof s.createdBy.displayName).toBe('string');
  expect(typeof s.createdBy.isAgent).toBe('boolean');
  for (const key of ['likes', 'dislikes', 'stars', 'points', 'messages'] as const) {
    expect(typeof s.counters[key]).toBe('number');
  }
  expect(s.state.kind).toBe(s.kind);
  expect(s.badges).toBeTypeOf('object');
}

describe('spaces & navigation', () => {
  it('lists the seeded space with members, and does NOT count unread', async () => {
    const { facade } = createRig();
    const spaces = await facade.listSpaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0].name).toBe('maestro-core');
    expect(spaces[0].memberCount).toBe(2);
    // There IS one unread message here — Forge's #v2-build message after the
    // read mark — and the space list still reports `null`, because the list is
    // the read that gates boot and counting unread means scanning every message
    // under RLS. The number is not lost; the test below reads it off
    // `navigation`, which is where it moved. `null` rather than `0` is what
    // keeps "not counted" from posing as "nothing to catch up on" — and the
    // seed proves the difference is real, since `0` here would be flatly wrong.
    expect(spaces[0].unreadTotal).toBeNull();
  });

  it('returns the channel tree with viewer and unread rollup', async () => {
    const { facade, ids } = createRig();
    const nav = await facade.getNavigation(ids.space);
    expect(nav.viewer.id).toBe(ids.subhang);
    expect(nav.viewer.isAgent).toBe(false);
    expect(nav.channels.map((c) => c.entity.title)).toEqual(['general', 'v2-build', 'design']);
    expect(nav.unreadTotal).toBe(1);
    const build = nav.channels[1].entity;
    expect(build.state.kind).toBe('channel');
    if (build.state.kind === 'channel') expect(build.state.unreadCount).toBe(1);
  });
});

describe('seed coverage', () => {
  it('contains every entity kind', async () => {
    const { facade, ids } = createRig();
    const kinds: EntityKind[] = ['channel','task','message','member','team_member','doc','file','spell','skill','pull_request','commit'];
    for (const kind of kinds) {
      const res = await facade.queryCollection({ spaceId: ids.space, kinds: [kind] });
      expect(res.page.items.length, `kind ${kind}`).toBeGreaterThan(0);
      for (const item of res.page.items) expectSummaryShape(item);
    }
  });

  it('represents every core edge type at least once (incl. x:*)', () => {
    const { facade } = createRig();
    const types = facade.withWorld((w) => new Set([...w.edges.values()].map((e) => e.type)));
    for (const t of ['assigned_to','depends_on','attached_to','tracks','pulled','working_on','completed_by','equips','relates_to','x:inspired_by','likes','stars']) {
      expect(types.has(t), `edge type ${t}`).toBe(true);
    }
    // depends_on hard AND soft
    const deps = facade.withWorld((w) => [...w.edges.values()].filter((e) => e.type === 'depends_on'));
    expect(deps.some((e) => e.props.hard === true)).toBe(true);
    expect(deps.some((e) => e.props.hard === false)).toBe(true);
    // pulled carries pinnedVersion
    const pulls = facade.withWorld((w) => [...w.edges.values()].filter((e) => e.type === 'pulled'));
    expect(pulls.length).toBeGreaterThanOrEqual(3);
    for (const p of pulls) expect(typeof p.props.pinnedVersion).toBe('number');
  });
});

describe('entity detail (Z3/Z4 shape)', () => {
  it('task detail: content, hierarchy, connections, capabilities, badges', async () => {
    const { facade, ids } = createRig();
    const t104 = await facade.getEntity(ids.t104);
    expect(t104.kind).toBe('task');
    expectSummaryShape(t104);
    expect(t104.content.kind).toBe('task');
    if (t104.content.kind === 'task') {
      expect(t104.content.acceptanceCriteria).toHaveLength(3);
      expect(t104.content.pointsEstimate).toBe(20);
    }
    expect(t104.hierarchy.parent?.id).toBe(ids.t100);
    expect(t104.hierarchy.path.map((p) => p.id)).toEqual([ids.t100]);
    // outgoing groups include assigned_to / tracks / equips; reactions never appear
    const outTypes = t104.connections.outgoing.map((g) => g.type);
    expect(outTypes).toEqual(expect.arrayContaining(['assigned_to', 'tracks', 'equips']));
    expect(outTypes).not.toContain('likes');
    const incTypes = t104.connections.incoming.map((g) => g.type);
    expect(incTypes).toEqual(expect.arrayContaining(['depends_on', 'attached_to', 'pulled', 'working_on']));
    expect(t104.capabilities.canComplete).toBe(true);
    expect(t104.capabilities.canPull).toBe(true);
    // live badges: Forge is working; Forge's pull pinned at v1 of v1 → not stale
    expect(t104.badges.workingActors?.[0]?.actor.id).toBe(ids.forge);
    expect(t104.badges.pulls?.[0]?.contentStale).toBe(false);
    expect(t104.badges.pulls?.[0]?.discussionMoved).toBe(true); // thread moved after pull
    if (t104.state.kind === 'task') {
      expect(t104.state.workStatus).toBe('working');
      expect(t104.state.assignees.map((a) => a.id)).toContain(ids.forge);
      expect(t104.state.acceptance).toEqual({ total: 3, completed: 2 });
    }
    expect(t104.counters.points).toBe(20);
    expect(t104.counters.messages).toBe(3);
    expect(t104.counters.likes).toBe(1);
  });

  it('blocked rollup: T-105 waits on T-104; T-106 dep is resolved', async () => {
    const { facade, ids } = createRig();
    const t105 = await facade.getEntity(ids.t105);
    expect(t105.badges.blocked?.unresolvedHardDependencyCount).toBe(1);
    expect(t105.badges.blocked?.waitingOn[0]?.id).toBe(ids.t104);
    expect(t105.connections.unresolvedHardDependencyCount).toBe(1);
    const t106 = await facade.getEntity(ids.t106);
    expect(t106.badges.blocked).toBeUndefined();
    const depGroup = t106.connections.outgoing.find((g) => g.type === 'depends_on');
    expect(depGroup?.edges[0]?.resolved).toBe(true);
    expect(depGroup?.edges[0]?.hard).toBe(true);
  });

  it('channel detail: shelf pins + auto-tabs derived from attached_to', async () => {
    const { facade, ids } = createRig();
    const hub = await facade.getEntity(ids.chBuild);
    expect(hub.content.kind).toBe('channel');
    if (hub.content.kind !== 'channel') return;
    expect(hub.content.pinned.map((p) => p.id).sort()).toEqual([ids.docSpec, ids.t100].sort());
    const tabs = hub.content.autoTabs;
    expect(tabs[0].key).toBe('feed');
    const byKey = Object.fromEntries(tabs.map((t) => [t.key, t]));
    expect(byKey.tasks.count).toBe(2);   // T-100, T-104
    expect(byKey.docs.count).toBe(1);    // spec doc
    expect(byKey.team.count).toBe(1);    // Forge
    expect(byKey.prs.count).toBe(1);     // PR #248
    expect(byKey.tasks.query.filters?.edge).toEqual({ type: 'attached_to', direction: 'outgoing', entityId: ids.chBuild });
    // the tab query actually resolves to the same entities
    const tasksTab = await facade.queryCollection(byKey.tasks.query);
    expect(tasksTab.page.items.map((i) => i.id).sort()).toEqual([ids.t100, ids.t104].sort());
  });

  it('team_member detail: identity, equipped items, work, live status', async () => {
    const { facade, ids } = createRig();
    const forge = await facade.getEntity(ids.forge);
    expect(forge.content.kind).toBe('team_member');
    if (forge.content.kind !== 'team_member') return;
    expect(forge.content.equipped.map((e) => e.id).sort()).toEqual([ids.skillGraphify, ids.spellReviewer].sort());
    expect(forge.content.work.map((w) => w.id)).toContain(ids.t104);
    if (forge.state.kind === 'team_member') {
      expect(forge.state.owner.id).toBe(ids.subhang);
      expect(forge.state.liveWork?.task.id).toBe(ids.t104);
    }
    // agent org tree: Scout and Probe are Forge's children
    expect(forge.hierarchy.children.items.map((c) => c.id).sort()).toEqual([ids.probe, ids.scout].sort());
  });

  it('member detail: owned team members and assigned work', async () => {
    const { facade, ids } = createRig();
    const subhang = await facade.getEntity(ids.subhang);
    if (subhang.content.kind !== 'member') throw new Error('expected member content');
    expect(subhang.content.teamMembers.map((t) => t.id).sort()).toEqual([ids.forge, ids.probe, ids.scout].sort());
    expect(subhang.content.work.map((w) => w.id)).toContain(ids.t103);
    if (subhang.state.kind === 'member') {
      expect(subhang.state.role).toBe('owner');
      expect(subhang.state.taskDoneCount).toBe(0); // Forge completed T-101, not Subhang
    }
  });

  it('lazy sections: hierarchy, connections, activity, versions, presence', async () => {
    const { facade, ids } = createRig();
    const hierarchy = await facade.getHierarchy(ids.t100);
    expect(hierarchy.children.items.map((c) => c.title)).toEqual([
      'T-101 · Schema foundation', 'T-102 · RLS policies', 'T-103 · Facade routes',
      'T-104 · Entity panel UI', 'T-105 · Graph canvas', 'T-106 · Docs reader',
      'T-107 · Leaderboard', 'T-108 · Onboarding tour',
    ]);
    const versions = await facade.getVersions(ids.docSpec);
    expect(versions.items.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    const activity = await facade.getActivity(ids.t104);
    expect(activity.items.length).toBeGreaterThan(0);
    expect(activity.items[0].createdAt).toMatch(ISO_RE);
    const presence = await facade.getPresence(ids.chBuild);
    expect(presence.viewers.map((v) => v.id).sort()).toEqual([ids.forge, ids.mira].sort());
  });
});

describe('collections & graph', () => {
  it('filters, sorts, groups by any axis, and paginates with cursors', async () => {
    const { facade, ids } = createRig();
    const board = await facade.queryCollection({
      spaceId: ids.space, kinds: ['task'], subtreeOf: ids.t100,
      groupBy: 'workStatus', sort: 'position',
    });
    expect(board.page.total).toBe(10); // 8 children + T-103a/b
    const statusKeys = board.groups?.map((g) => g.key) ?? [];
    expect(statusKeys).toEqual(expect.arrayContaining(['open', 'working', 'in_review', 'done']));
    const byAxis = await facade.queryCollection({
      spaceId: ids.space, kinds: ['task'], subtreeOf: ids.t100, groupBy: 'axis:type',
    });
    expect(byAxis.groups?.map((g) => g.key)).toEqual(expect.arrayContaining(['code', 'design', 'review', 'test']));
    const paged = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'], limit: 4 });
    expect(paged.page.items).toHaveLength(4);
    // DEV-5: cursors are opaque keyset strings — never offsets
    expect(typeof paged.page.nextCursor).toBe('string');
    expect(paged.page.nextCursor).not.toMatch(/^off:/);
    const page2 = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'], limit: 4, cursor: paged.page.nextCursor as string });
    const page1Ids = new Set(paged.page.items.map((i) => i.id));
    expect(page2.page.items.length).toBeGreaterThan(0);
    expect(page2.page.items.every((i) => !page1Ids.has(i.id))).toBe(true); // no overlap, no skips
  });

  it('readyToPull excludes blocked and non-open tasks', async () => {
    const { facade, ids } = createRig();
    const ready = await facade.queryCollection({
      spaceId: ids.space, kinds: ['task'], filters: { readyToPull: true },
    });
    const readyIds = ready.page.items.map((i) => i.id);
    expect(readyIds).not.toContain(ids.t105); // blocked on T-104
    expect(readyIds).not.toContain(ids.t104); // working
    expect(readyIds).toContain(ids.t103);
    expect(readyIds).toContain(ids.t107);     // soft dep does not block
  });

  it('graph dependency mode exposes the blocked red path from the seed', async () => {
    const { facade, ids } = createRig();
    const graph = await facade.queryGraph({
      spaceId: ids.space, kinds: ['task'], subtreeOf: ids.t100, mode: 'dependency',
    });
    expect(graph.edges.every((e) => e.type === 'depends_on')).toBe(true);
    const blockedEdge = graph.edges.find((e) => e.source.id === ids.t105);
    expect(blockedEdge?.hard).toBe(true);
    expect(blockedEdge?.resolved).toBe(false); // T-105 → T-104: the red path
    const resolvedEdge = graph.edges.find((e) => e.source.id === ids.t106);
    expect(resolvedEdge?.resolved).toBe(true);
    // clusters carry hierarchy containment separately from edges
    expect(graph.clusters.find((c) => c.parentId === ids.t103)?.childIds.sort())
      .toEqual([ids.t103a, ids.t103b].sort());
  });

  it('graph focus mode walks N hops around an entity', async () => {
    const { facade, ids } = createRig();
    const graph = await facade.queryGraph({ spaceId: ids.space, focusId: ids.forge, hops: 1 });
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toEqual(expect.arrayContaining([ids.forge, ids.t104, ids.spellReviewer, ids.skillGraphify, ids.scout, ids.probe]));
  });
});

describe('threads, home, inbox, leaderboard, axes, settings, search', () => {
  it('thread pages: roots with nested replies, rootId flattens the thread', async () => {
    const { facade, ids } = createRig();
    const roots = await facade.getMessages(ids.t104);
    expect(roots.items).toHaveLength(1);
    const root = roots.items[0];
    expect(root.id).toBe(ids.forgeProgressMessage);
    expect(root.replyCount).toBe(1);
    expect(root.replies?.items[0].content.body).toContain('tab order');
    const flat = await facade.getMessages(ids.t104, { rootId: ids.forgeProgressMessage });
    expect(flat.items).toHaveLength(3); // root + correction + ack
    expect(flat.items.every((m) => m.state.kind === 'message')).toBe(true);
    const agentMsg = flat.items.find((m) => m.state.author.isAgent);
    expect(agentMsg).toBeDefined();
  });

  it('home presets: readyToPull / inFlight / needsMe scoped to the viewer', async () => {
    const { facade, ids } = createRig();
    const home = await facade.getHome(ids.space);
    expect(home.readyToPull.page.items.map((i) => i.id)).toEqual([ids.t103]);
    expect(home.inFlight.page.items.map((i) => i.id)).toEqual([ids.t104]);
    expect(home.needsMe.page.items.map((i) => i.id)).toEqual([ids.t106]);
    // in-flight carries the staleness-capable pull badge
    expect(home.inFlight.page.items[0].badges.pulls?.[0].actor.id).toBe(ids.forge);
    expect(home.activity.items.length).toBeGreaterThan(0);
  });

  it('inbox holds assignment/mention/award/review_request rows for the viewer', async () => {
    const { facade } = createRig();
    const inbox = await facade.getInbox();
    const kinds = new Set(inbox.items.map((n) => n.kind));
    for (const k of ['assignment', 'mention', 'award', 'review_request']) {
      expect(kinds.has(k), `inbox kind ${k}`).toBe(true);
    }
    expect(inbox.items.every((n) => n.readAt === null)).toBe(true);
  });

  it('leaderboard ranks humans and agents from the ledger', async () => {
    const { facade, ids } = createRig();
    const board = await facade.getLeaderboard(ids.space);
    expect(board.items[0].actor.id).toBe(ids.forge); // 15-point T-101 award
    expect(board.items[0].score).toBe(15);
    expect(board.items[0].rank).toBe(1);
    expect(board.items[1].actor.id).toBe(ids.mira);  // 8-point kudos
    const awards = await facade.getAwards(ids.space);
    expect(awards.items).toHaveLength(1);
    expect(awards.items[0].recipient.id).toBe(ids.forge);
    expect(awards.items[0].ref?.id).toBe(ids.t101);
    expect(awards.items[0].amount).toBe(15);
  });

  it('task axes: seeded default + manual, uniform in queries', async () => {
    const { facade, ids } = createRig();
    const axes = await facade.getTaskAxes(ids.space);
    expect(axes.map((a) => [a.name, a.kind])).toEqual([['type', 'default'], ['milestone', 'manual']]);
    const settings = await facade.getSettings(ids.space);
    expect(settings.members).toHaveLength(2);
    expect(settings.taskAxes).toHaveLength(2);
    expect(settings.invites[0].code).toBe('CORE-JOIN');
  });

  it('saved views + palette actions; search is a typed not_implemented (DEV-13)', async () => {
    const { facade, ids } = createRig();
    const views = await facade.listSavedViews(ids.space);
    expect(views.map((v) => v.name)).toEqual(expect.arrayContaining([
      'V2 milestone · dependencies', 'Spec docs · tree', 'Forge · kit',
    ]));
    expect(views.find((v) => v.id === ids.viewDependencies)?.graphLayout?.[ids.t104]).toEqual({ x: 260, y: 40 });
    // DEV-13: search stays on the seam but is deferred for v1
    await expect(facade.search('panel', { spaceId: ids.space }))
      .rejects.toMatchObject({ code: 'not_implemented', status: 501 });
    const actions = await facade.getActions(ids.t104);
    expect(actions.some((a) => a.kind === 'pull' && a.targetEntityId === ids.t104)).toBe(true);
  });

  it('lists exclude soft-deleted entities by default; tombstone summary retains shape', async () => {
    const { facade, ids } = createRig();
    await facade.deleteEntity(ids.t108, { actorId: ids.subhang });
    const tasks = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'], subtreeOf: ids.t100 });
    expect(tasks.page.items.map((i) => i.id)).not.toContain(ids.t108);
    const only = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'], filters: { deleted: 'only' } });
    expect(only.page.items.map((i) => i.id)).toContain(ids.t108);
    expect(only.page.items.find((i) => i.id === ids.t108)?.deletedAt).toMatch(ISO_RE);
  });
});
