import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE, STORY_FIXTURE_EMPTY } from '../fixture';
import { ATTENTION_KIND, TASK_KIND, type StoryNode, type StorySession, type StoryView } from '../model';
import { buildWorld, doorstep } from './world';
import { latestTaskSignal, robotAttention, robotStand, robotsFor } from './robots';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const session = (id: string, taskIds: string[], extra: Partial<StorySession> = {}): StorySession => ({
  id, title: `${id} session`, callSign: id.toUpperCase(), createdAt: new Date(NOW - 60_000).toISOString(), live: true,
  runtimeStatus: 'running', model: null, teamMemberId: null, mode: 'worker', taskIds, rootIds: [], dispatchedById: null, ...extra,
});
const withSessions = (base: StoryView, sessions: StorySession[]): StoryView => ({ ...base, page: { ...base.page, sessions } });
const attentionKind = ATTENTION_KIND;

describe('robotStand', () => {
  const world = buildWorld(STORY_FIXTURE, NOW);
  const tasks = STORY_FIXTURE.page.nodes.filter((n) => n.kind === TASK_KIND && n.id !== STORY_FIXTURE.id);
  const [a, b] = [tasks[0]!, tasks[1]!];

  it('stands a single-task session on that task’s doorstep, facing it', () => {
    const stand = robotStand(session('s', [a.id]), world, NOW);
    const place = world.byId.get(a.id)!;
    expect(stand).toMatchObject({ ...doorstep(place), placeId: a.id, reason: 'task' });
    expect(Math.abs(Math.sin(stand.facing))).toBeLessThan(1e-9);
    expect(Math.cos(stand.facing)).toBeLessThan(0);
  });

  it('ignores task ids that are not in the world and never reads taskIds order as recency', () => {
    const stand = robotStand(session('s', ['not-here', a.id]), world, NOW);
    expect(stand).toMatchObject({ placeId: a.id, reason: 'task' });
    const several = robotStand(session('s', [b.id, a.id]), world, NOW);
    expect(several.reason).toBe('stable');
    expect(several.placeId).toBe([a.id, b.id].sort()[0]);
  });

  it('follows the newest real per-task signal by the session or its teammate (provisional)', () => {
    const s = session('s', [a.id, b.id], { teamMemberId: 'tm-x' });
    const page = {
      activity: [{ id: 'e1', at: new Date(NOW - 5 * 60_000).toISOString(), entityId: a.id, entityKind: TASK_KIND, entityTitle: a.title, verb: 'updated', actorId: 'tm-x', actor: null }],
      recentMessages: [{ id: 'm1', at: new Date(NOW - 60_000).toISOString(), anchorId: b.id, anchorKind: TASK_KIND, anchorTitle: b.title, authorId: 's', author: null, excerpt: 'on it' }],
    };
    expect(latestTaskSignal(s, new Set([a.id, b.id]), page)).toMatchObject({ taskId: b.id });
    expect(robotStand(s, world, NOW, { page })).toMatchObject({ placeId: b.id, reason: 'recent-task' });
    // Someone else's activity on the task is not this session's signal.
    const foreign = { ...page, recentMessages: [{ ...page.recentMessages[0]!, authorId: 'someone-else' }] };
    expect(robotStand(s, world, NOW, { page: foreign })).toMatchObject({ placeId: a.id, reason: 'recent-task' });
    expect(robotStand(s, world, NOW, { page: { activity: [], recentMessages: [] } }).reason).toBe('stable');
  });

  it('parks a taskless session in the depot ring beside the hub (provisional), spaced by index', () => {
    const hub = world.byId.get(world.hubId)!;
    const first = robotStand(session('s', []), world, NOW, { depotIndex: 0, depotCount: 3 });
    const third = robotStand(session('t', []), world, NOW, { depotIndex: 2, depotCount: 3 });
    for (const stand of [first, third]) {
      expect(stand).toMatchObject({ placeId: null, reason: 'depot' });
      const r = Math.hypot(stand.x - hub.x, stand.z - hub.z);
      expect(r).toBeGreaterThan(hub.footprint);
      expect(r).toBeLessThan(hub.footprint + 1.5);
    }
    expect(Math.hypot(first.x - third.x, first.z - third.z)).toBeGreaterThan(.8);
  });

  it('is pure: equal inputs give equal stands', () => {
    const s = session('s', [a.id, b.id]);
    expect(robotStand(s, world, NOW)).toEqual(robotStand(s, world, NOW));
    expect(robotStand(s, world, NOW)).toEqual(robotStand(s, buildWorld(STORY_FIXTURE, NOW), NOW + 1));
  });
});

describe('robotsFor', () => {
  it('gives exactly one robot per live session on the fixture; completed sessions get none', () => {
    const world = buildWorld(STORY_FIXTURE, NOW);
    const robots = robotsFor(STORY_FIXTURE, world, NOW);
    const live = STORY_FIXTURE.page.sessions.filter((s) => s.live);
    expect(live.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThan(STORY_FIXTURE.page.sessions.length);
    expect(robots.map((r) => r.id)).toEqual(live.map((s) => s.id));
    for (const done of STORY_FIXTURE.page.sessions.filter((s) => !s.live)) expect(robots.some((r) => r.id === done.id)).toBe(false);
    // The fixture's Worker session has two tasks and a recent activity row on one of them.
    const worker = robots.find((r) => r.id === 'fx-s3')!;
    expect(worker.stand).toMatchObject({ placeId: 'fx-c33', reason: 'recent-task' });
    expect(robots.find((r) => r.id === 'fx-s2')!.stand.reason).toBe('task');
    expect(robots.find((r) => r.id === 'fx-s4')!.stand.reason).toBe('depot');
  });

  it.each([0, 1, 7])('counts %i robots for %i live sessions on a synthetic page', (count) => {
    const sessions = Array.from({ length: count }, (_, i) => session(`live-${i}`, []));
    const finished = [session('done-a', [], { live: false, runtimeStatus: 'exited' }), session('done-b', [], { live: false })];
    const view = withSessions(STORY_FIXTURE_EMPTY, [...finished, ...sessions]);
    const robots = robotsFor(view, buildWorld(view, NOW), NOW);
    expect(robots).toHaveLength(count);
    expect(new Set(robots.map((r) => `${r.stand.x.toFixed(3)}/${r.stand.z.toFixed(3)}`)).size).toBe(count);
    for (const r of robots) expect(r.attention).toBe(false);
  });

  it('stands two sessions on one task side by side on its doorstep', () => {
    const world = buildWorld(STORY_FIXTURE, NOW);
    const task = STORY_FIXTURE.page.nodes.find((n) => n.kind === TASK_KIND && n.id !== STORY_FIXTURE.id)!;
    const view = withSessions(STORY_FIXTURE, [session('p', [task.id]), session('q', [task.id])]);
    const [p, q] = robotsFor(view, world, NOW);
    expect(p!.stand.placeId).toBe(task.id);
    expect(q!.stand.placeId).toBe(task.id);
    expect(p!.stand.z).toBe(q!.stand.z);
    expect(Math.abs(p!.stand.x - q!.stand.x)).toBeCloseTo(1);
  });
});

describe('attention indicator', () => {
  const task = STORY_FIXTURE.page.nodes.find((n) => n.kind === TASK_KIND && n.id !== STORY_FIXTURE.id)!;
  const attention: StoryNode = { id: 'att-1', kind: attentionKind, title: 'needs a ruling', status: 'pending', statusCategory: 'to_do', blocked: false, depth: 2, rootIds: task.rootIds, activityAt: null, createdAt: new Date(NOW).toISOString() };
  const beside = (base: StoryView): StoryView => ({
    ...base,
    page: { ...base.page, nodes: [...base.page.nodes, attention], edges: [...base.page.edges, { id: 'e-att', fromId: attention.id, toId: task.id, type: 'about', family: 'parent', cross: false, rootIds: task.rootIds }], sessions: [session('s', [task.id])] },
  });

  it('is off while the story has no pending attention, whatever the graph says', () => {
    const view = { ...beside(STORY_FIXTURE), state: { ...STORY_FIXTURE.state, pendingAttentionCount: 0 } };
    const world = buildWorld(view, NOW);
    expect(robotsFor(view, world, NOW).map((r) => r.attention)).toEqual([false]);
  });

  it('is on when the story has pending attention and an attention node stands beside the robot’s task (provisional)', () => {
    const view = { ...beside(STORY_FIXTURE), state: { ...STORY_FIXTURE.state, pendingAttentionCount: 1 } };
    const world = buildWorld(view, NOW);
    const [robot] = robotsFor(view, world, NOW);
    expect(world.adjacency.get(task.id)).toContain(attention.id);
    expect(robot!.attention).toBe(true);
  });

  it('stays off for a task with no attention node beside it, and for depot robots', () => {
    const view = withSessions({ ...STORY_FIXTURE, state: { ...STORY_FIXTURE.state, pendingAttentionCount: 3 } }, [session('s', [task.id]), session('d', [])]);
    const world = buildWorld(view, NOW);
    expect(robotsFor(view, world, NOW).map((r) => r.attention)).toEqual([false, false]);
  });

  it('prefers a per-node pending count when the page carries one', () => {
    const view = { ...STORY_FIXTURE, state: { ...STORY_FIXTURE.state, pendingAttentionCount: 1 } };
    const world = buildWorld(view, NOW);
    const counted = new Map<string, StoryNode>([[task.id, { ...task, counts: { messages: 0, pendingAttention: 2 } }]]);
    const zero = new Map<string, StoryNode>([[task.id, { ...task, counts: { messages: 0, pendingAttention: 0 } }]]);
    const stand = robotStand(session('s', [task.id]), world, NOW);
    expect(robotAttention(view, stand, world, counted)).toBe(true);
    expect(robotAttention(view, stand, world, zero)).toBe(false);
  });
});

describe('robotHue', () => {
  it('spreads neighbouring session ids across the hue slots and is stable', async () => {
    const { robotHue } = await import('./scene-robots');
    const ids = ['fx-s2', 'fx-s3', 'fx-s4', 'robot-extra-0', 'robot-extra-1', 'robot-extra-2', 'robot-extra-3'];
    const slots = ids.map((id) => robotHue(id, 4));
    expect(new Set(slots).size).toBeGreaterThanOrEqual(3);
    for (const [i, id] of ids.entries()) { expect(slots[i]).toBe(robotHue(id, 4)); expect(slots[i]).toBeGreaterThanOrEqual(0); expect(slots[i]).toBeLessThan(4); }
  });
});
