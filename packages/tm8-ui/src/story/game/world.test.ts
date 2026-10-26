import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { TASK_KIND, VIEW_OF_KIND, type StoryGraphEdge, type StoryNode, type StoryView } from '../model';
import { LANDMARK_GAP, MIN_DISTANCE, buildWorld, layoutWorld, nearestPlace, roadPath, storySource, type WorldNode, type WorldSource } from './world';
import { DISTRICT_ORDER, districtOf } from './world-groups';

const madeOrCode = (n: { kind: string }): boolean => VIEW_OF_KIND[n.kind] === 'made' || VIEW_OF_KIND[n.kind] === 'code';
const angleOf = (p: { x: number; z: number }): number => { const a = Math.atan2(p.z, p.x); return a < -Math.PI / 2 ? a + Math.PI * 2 : a; };

/** A pure 125-place story in the spacious shape (e2e/story-spacious-fixture.ts mutates the shared fixture, so it is rebuilt here). */
function spaciousView(count: number): StoryView {
  const view = structuredClone(STORY_FIXTURE);
  const roots = view.page.roots.slice(0, 5);
  while (view.page.nodes.length < count) {
    const i = view.page.nodes.length, root = roots[i % roots.length]!;
    const id = `spacious-${i}`;
    view.page.nodes.push({ ...view.page.nodes[1]!, id, title: `Field station ${i}`, rootIds: [root.id], createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), activityAt: null, live: false });
    root.childIds.push(id);
    view.page.edges.push({ id: `edge-${i}`, fromId: root.id, toId: id, type: 'parent', family: 'parent', cross: false, rootIds: [root.id] });
    if (i % 8 === 0) view.page.edges.push({ id: `bridge-${i}`, fromId: `spacious-${i - 1}`, toId: id, type: 'depends_on', family: 'blocks', cross: true, rootIds: [root.id] });
  }
  return view;
}

describe('buildWorld', () => {
  const world = buildWorld(STORY_FIXTURE);

  it('places the story at the hub and every open-map node and child story once', () => {
    const hub = world.byId.get(STORY_FIXTURE.id)!;
    expect(hub.shape).toBe('hub');
    expect([hub.x, hub.z]).toEqual([0, 0]);
    const ids = world.places.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of STORY_FIXTURE.page.nodes) expect(world.byId.has(n.id), n.id).toBe(!madeOrCode(n));
    for (const c of STORY_FIXTURE.page.childStories) expect(world.byId.get(c.id)?.portal).toBe(true);
    for (const r of STORY_FIXTURE.page.roots) expect(world.byId.get(r.id)?.root).toBe(true);
  });

  it('folds made nodes into one Library and code nodes into one Code Factory, each with members and the members\' roads', () => {
    const library = world.byId.get(`${STORY_FIXTURE.id}:library`)!, factory = world.byId.get(`${STORY_FIXTURE.id}:code`)!;
    expect(library.shape).toBe('library');
    expect(VIEW_OF_KIND[library.kind]).toBe('made');
    expect(factory.shape).toBe('factory');
    expect(VIEW_OF_KIND[factory.kind]).toBe('code');
    const made = STORY_FIXTURE.page.nodes.filter((n) => VIEW_OF_KIND[n.kind] === 'made'), code = STORY_FIXTURE.page.nodes.filter((n) => VIEW_OF_KIND[n.kind] === 'code');
    expect(made.length).toBeGreaterThan(0);
    expect(code.length).toBeGreaterThan(0);
    expect(library.members.map((m) => m.id).sort()).toEqual(made.map((n) => n.id).sort());
    expect(factory.members.map((m) => m.id).sort()).toEqual(code.map((n) => n.id).sort());
    expect(world.places.filter((p) => p.members.length)).toHaveLength(2);
    // A member's anchors are the places it was attached to; the landmark carries their roads, deduplicated.
    const doc = library.members.find((m) => m.id === 'fx-d1')!;
    expect(doc.anchorIds).toEqual(['fx-c33', 'fx-r1']);
    for (const m of library.members) for (const a of m.anchorIds) expect(world.roads.some((r) => (r.fromId === library.id && r.toId === a) || (r.fromId === a && r.toId === library.id)), `${m.id}→${a}`).toBe(true);
    expect(new Set(world.roads.map((r) => r.id)).size).toBe(world.roads.length);
    expect(roadPath(world, world.hubId, library.id)).not.toBeNull();
    expect(roadPath(world, world.hubId, factory.id)).not.toBeNull();
  });

  it('builds no landmark without members', () => {
    const page = { ...STORY_FIXTURE.page, nodes: STORY_FIXTURE.page.nodes.filter((n) => VIEW_OF_KIND[n.kind] !== 'code') };
    const noCode = buildWorld({ ...STORY_FIXTURE, page });
    expect(noCode.byId.has(`${STORY_FIXTURE.id}:code`)).toBe(false);
    expect(noCode.byId.has(`${STORY_FIXTURE.id}:library`)).toBe(true);
  });

  it('gives every task its shelf and mailbox counts from the page, and a worker flag from live sessions', () => {
    const { page } = STORY_FIXTURE;
    const tasks = world.places.filter((p) => p.kind === TASK_KIND);
    expect(tasks.length).toBeGreaterThan(5);
    for (const t of tasks) {
      const shelf = new Set(page.edges.flatMap((e) => e.family !== 'made' ? [] : [e.fromId === t.id ? e.toId : e.toId === t.id ? e.fromId : ''])
        .filter((id) => id && VIEW_OF_KIND[page.nodes.find((n) => n.id === id)?.kind ?? ''] === 'made'));
      expect(t.attachments, t.id).not.toBeNull();
      expect(t.attachments!.library.count).toBe(shelf.size);
      expect([...t.attachments!.library.memberIds].sort()).toEqual([...shelf].sort());
      expect(t.attachments!.mailbox.count).toBe(page.recentMessages.filter((m) => m.anchorId === t.id).length);
      expect(t.attachments!.mailbox.approx).toBe(false);
      expect(t.hasWorker).toBe(page.sessions.some((s) => s.live && s.taskIds.includes(t.id)));
    }
    expect(world.byId.get('fx-r1')!.attachments!.library.memberIds).toEqual(['fx-d1']);
    expect(world.byId.get('fx-r1')!.attachments!.mailbox.count).toBe(2);
    expect(world.byId.get('fx-r3')!.hasWorker).toBe(true);
    expect(world.byId.get('fx-r4')!.hasWorker).toBe(false);
    expect(world.byId.get('fx-s3')!.hasWorker).toBe(true);
    for (const p of world.places.filter((p) => p.kind !== TASK_KIND)) expect(p.attachments).toBeNull();
  });

  it('marks the mailbox approximate at the page window and prefers a server tally when a node carries one', () => {
    const { page } = STORY_FIXTURE;
    const filler = Array.from({ length: 50 }, (_, i) => ({ ...page.recentMessages[0]!, id: `fill-${i}`, anchorId: 'fx-r2' }));
    const windowed = buildWorld({ ...STORY_FIXTURE, page: { ...page, recentMessages: filler } });
    expect(windowed.byId.get('fx-r2')!.attachments!.mailbox).toEqual({ count: 50, approx: true });
    expect(windowed.byId.get('fx-r1')!.attachments!.mailbox).toEqual({ count: 0, approx: true });
    const counted = buildWorld({ ...STORY_FIXTURE, page: { ...page, recentMessages: filler, nodes: page.nodes.map((n) => n.id === 'fx-r1' ? { ...n, counts: { messages: 7, pendingAttention: 2 } } : n) } });
    expect(counted.byId.get('fx-r1')!.attachments!.mailbox).toEqual({ count: 7, approx: false });
    expect(counted.byId.get('fx-r1')!.pendingAttention).toBe(2);
    expect(counted.byId.get('fx-r2')!.pendingAttention).toBeNull();
  });

  it('stands hierarchy children on their parent\'s site, nearer their parent than any other parent', () => {
    const parents = new Map(STORY_FIXTURE.page.edges.filter((e) => e.type === 'parent').map((e) => [e.toId, e.fromId]));
    expect(parents.size).toBeGreaterThan(5);
    const parentPlaces = [...new Set(parents.values())].map((id) => world.byId.get(id)!);
    for (const [childId, parentId] of parents) {
      const child = world.byId.get(childId)!, parent = world.byId.get(parentId)!;
      expect(child.parentId).toBe(parentId);
      expect(child.anchorId).toBe(parentId);
      expect(child.ring).toBe(parent.ring + 1);
      const d = Math.hypot(child.x - parent.x, child.z - parent.z);
      expect(d).toBeLessThanOrEqual(parent.siteRadius);
      expect(d).toBeGreaterThanOrEqual(MIN_DISTANCE - .05);
      for (const other of parentPlaces) if (other !== parent) expect(Math.hypot(child.x - other.x, child.z - other.z)).toBeGreaterThan(d);
      expect(roadPath(world, parentId, childId)).toEqual([parentId, childId]);
    }
    expect(world.byId.get('fx-r1')!.siteRadius).toBeGreaterThan(world.byId.get('fx-c11')!.siteRadius);
    for (const p of world.places.filter((p) => !parents.has(p.id))) expect(p.parentId).toBeNull();
  });

  it('nests a grandchild on its parent\'s site inside the root\'s site and keeps a trail node anchored to a site child', () => {
    const edges: StoryGraphEdge[] = [...STORY_FIXTURE.page.edges.filter((e) => !(e.type === 'parent' && e.toId === 'fx-c12')), { id: null, fromId: 'fx-c11', toId: 'fx-c12', type: 'parent', family: 'parent', cross: false, rootIds: ['fx-r1'] }];
    const nested = buildWorld({ ...STORY_FIXTURE, page: { ...STORY_FIXTURE.page, edges } });
    const root = nested.byId.get('fx-r1')!, c11 = nested.byId.get('fx-c11')!, c12 = nested.byId.get('fx-c12')!;
    expect(c12.parentId).toBe('fx-c11');
    expect(Math.hypot(c12.x - c11.x, c12.z - c11.z)).toBeLessThanOrEqual(c11.siteRadius);
    expect(Math.hypot(c12.x - root.x, c12.z - root.z)).toBeLessThanOrEqual(root.siteRadius);
    expect(c12.ring).toBe(c11.ring + 1);
    // fx-m3 is remembered by fx-c51 (a site child): it stands by that task, not on the commons.
    expect(nested.byId.get('fx-m3')!.anchorId).toBe('fx-c51');
    expect(nested.roads.some((r) => (r.fromId === 'fx-c51' && r.toId === 'fx-m3') || (r.fromId === 'fx-m3' && r.toId === 'fx-c51'))).toBe(true);
    expect(Math.hypot(nested.byId.get('fx-m3')!.x - nested.byId.get('fx-c51')!.x, nested.byId.get('fx-m3')!.z - nested.byId.get('fx-c51')!.z)).toBeLessThan(MIN_DISTANCE * 2.5);
  });

  it('assigns every task a district by status and lays districts out as ordered angular sectors', () => {
    expect(world.districts.map((d) => d.id)).toEqual(DISTRICT_ORDER.filter((d) => world.places.some((p) => p.district === d)));
    expect(world.districts[0]!.from).toBeCloseTo(-Math.PI / 2);
    expect(world.districts.at(-1)!.to).toBeCloseTo(Math.PI * 1.5);
    for (const [i, d] of world.districts.entries()) { expect(d.to).toBeGreaterThan(d.from); if (i) expect(d.from).toBeCloseTo(world.districts[i - 1]!.to); }
    const sector = new Map(world.districts.map((d) => [d.id, d]));
    for (const p of world.places) {
      const n = STORY_FIXTURE.page.nodes.find((x) => x.id === p.id);
      if (n?.kind === TASK_KIND) expect(p.district, p.id).toBe(districtOf(n));
      else expect(p.district).toBeNull();
      if (!p.root) continue;
      const s = sector.get(p.district!)!, a = angleOf(p);
      expect(a, p.id).toBeGreaterThanOrEqual(s.from - 1e-9);
      expect(a, p.id).toBeLessThanOrEqual(s.to + 1e-9);
    }
    expect(world.byId.get('fx-r5')!.district).toBe('blocked');
    expect(world.byId.get('fx-r1')!.district).toBe('done');
  });

  it('moves a root to its new sector when its status changes district, and nothing else when only activity changes', () => {
    const bump = (f: (n: StoryNode) => StoryNode) => buildWorld({ ...STORY_FIXTURE, page: { ...STORY_FIXTURE.page, nodes: STORY_FIXTURE.page.nodes.map(f) } });
    const warm = bump((n) => ({ ...n, activityAt: new Date().toISOString(), live: n.kind === TASK_KIND ? false : n.live }));
    expect(warm.places.map((p) => [p.id, p.x, p.z])).toEqual(world.places.map((p) => [p.id, p.x, p.z]));
    const finished = bump((n) => (n.id === 'fx-r4' ? { ...n, status: 'done', statusCategory: 'done' as const } : n));
    expect(finished.byId.get('fx-r4')!.district).toBe('done');
    const done = finished.districts.find((d) => d.id === 'done')!;
    expect(angleOf(finished.byId.get('fx-r4')!)).toBeGreaterThanOrEqual(done.from);
    expect(angleOf(finished.byId.get('fx-r4')!)).toBeLessThanOrEqual(done.to);
    expect(finished.districts.map((d) => d.id)).toEqual(['in_progress', 'blocked', 'done']);
  });

  it('lays 125 places out with sites and districts under 600 ms, fully spaced and road-connected', () => {
    const view = spaciousView(125);
    const start = performance.now();
    const big = buildWorld(view);
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(600);
    expect(big.places.length).toBeGreaterThanOrEqual(125 - 8 + 2);
    for (const [i, a] of big.places.entries()) for (const b of big.places.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.z - b.z) - a.footprint - b.footprint).toBeGreaterThanOrEqual(LANDMARK_GAP - 1e-6);
    for (const p of big.places) if (big.roads.some((r) => r.fromId === p.id || r.toId === p.id)) expect(roadPath(big, big.hubId, p.id), p.id).not.toBeNull();
    expect(buildWorld(view).places.map((p) => [p.id, p.x, p.z])).toEqual(big.places.map((p) => [p.id, p.x, p.z]));
  });

  it('keeps every two places apart', () => {
    for (let i = 0; i < world.places.length; i++) {
      for (let j = i + 1; j < world.places.length; j++) {
        const a = world.places[i]!;
        const b = world.places[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(MIN_DISTANCE - 0.05);
      }
    }
  });

  it('is deterministic and stable under a status change', () => {
    const again = buildWorld(STORY_FIXTURE);
    expect(again.places.map((p) => [p.id, p.x, p.z])).toEqual(world.places.map((p) => [p.id, p.x, p.z]));
    const first = STORY_FIXTURE.page.nodes[1]!;
    const bumped = {
      ...STORY_FIXTURE,
      page: {
        ...STORY_FIXTURE.page,
        nodes: STORY_FIXTURE.page.nodes.map((n) => (n.id === first.id ? { ...n, status: 'done', statusCategory: 'done' as const } : n)),
      },
    };
    const moved = buildWorld(bumped);
    expect(moved.places.map((p) => [p.id, p.x, p.z])).toEqual(world.places.map((p) => [p.id, p.x, p.z]));
    expect(moved.byId.get(first.id)?.tone).toBe('done');
  });

  it('roads reach source-connected places from the hub', () => {
    for (const p of world.places.filter((p) => world.roads.some((r) => r.fromId === p.id || r.toId === p.id))) {
      const path = roadPath(world, world.hubId, p.id);
      expect(path, p.title).not.toBeNull();
      expect(path![0]).toBe(world.hubId);
      expect(path![path!.length - 1]).toBe(p.id);
    }
  });

  it('colours a blocking edge as a bridge, not a gate', () => {
    const bridges = world.roads.filter((r) => r.family === 'blocks');
    const inPage = STORY_FIXTURE.page.edges.filter((e) => e.family === 'blocks');
    expect(bridges.length).toBe(inPage.length);
  });

  it('finds the nearest place within reach', () => {
    const root = world.places.find((p) => p.root)!;
    expect(nearestPlace(world, root.x + 0.3, root.z - 0.2, 1)?.id).toBe(root.id);
    expect(nearestPlace(world, 1000, 1000, 1)).toBeNull();
  });
});

describe('layoutWorld (generic)', () => {
  const node = (id: string, createdAt: string, anchorId: string | null = null): WorldNode => ({
    id, kind: 'thing', title: id, status: null, statusCategory: null, blocked: false, live: false,
    createdAt, activityAt: null, progress: null, anchorId, rootIds: [],
  });
  const src: WorldSource = {
    id: 'hub',
    hub: { ...node('hub', '2026-01-01T00:00:00Z'), progress: 0.5 },
    landmarks: [node('L1', '2026-01-02T00:00:00Z', 'hub'), node('L2', '2026-01-03T00:00:00Z', 'hub')],
    nodes: [
      node('old', '2026-01-04T00:00:00Z', 'L1'),
      node('mid', '2026-02-04T00:00:00Z', 'L1'),
      node('new', '2026-03-04T00:00:00Z', 'L1'),
      node('loose', '2026-03-05T00:00:00Z', null),
    ],
    portals: [node('other-world', '2026-01-01T00:00:00Z', 'hub')],
    edges: [{ fromId: 'loose', toId: 'L2', type: 'about', family: 'story', cross: false }, { fromId: 'hub', toId: 'L2', type: 'contains', family: 'story', cross: false }],
  };
  const world = layoutWorld(src, Date.parse('2026-03-06T00:00:00Z'));

  it('lays any graph out: hub, landmarks, anchored nodes, portals on the rim', () => {
    expect(world.byId.get('hub')?.shape).toBe('hub');
    expect(world.byId.get('L1')?.root).toBe(true);
    expect(world.byId.get('other-world')?.portal).toBe(true);
    expect(Math.hypot(world.byId.get('other-world')!.x, world.byId.get('other-world')!.z)).toBeGreaterThan(Math.hypot(world.byId.get('L1')!.x, world.byId.get('L1')!.z));
    // An unanchored node hangs off the neighbour its edge names.
    expect(world.byId.get('loose')?.anchorId).toBe('L2');
    expect(roadPath(world, 'hub', 'loose')).toEqual(['hub', 'L2', 'loose']);
  });

  it('time is distance: the newest sibling stands nearest its anchor', () => {
    const l1 = world.byId.get('L1')!;
    const d = (id: string): number => { const p = world.byId.get(id)!; return Math.hypot(p.x - l1.x, p.z - l1.z); };
    expect(d('new')).toBeLessThan(d('mid'));
    expect(d('mid')).toBeLessThan(d('old'));
  });

  it('exposes no districts and keeps the even landmark ring when nothing has a district', () => {
    expect(world.districts).toEqual([]);
    const l1 = world.byId.get('L1')!, l2 = world.byId.get('L2')!;
    expect(Math.hypot(l1.x, l1.z)).toBeCloseTo(Math.hypot(l2.x, l2.z));
    expect(l1.z).toBeLessThan(0);
  });

  it('places site children from parentId, cuts parent cycles and ignores a parent it cannot see', () => {
    const kids = Array.from({ length: 7 }, (_, i) => ({ ...node(`k${i}`, `2026-02-0${i + 1}T00:00:00Z`, 'L1'), parentId: 'L1' }));
    const nodes: WorldNode[] = [...kids, { ...node('a', '2026-01-10T00:00:00Z'), parentId: 'b' }, { ...node('b', '2026-01-11T00:00:00Z'), parentId: 'a' }, { ...node('orphan', '2026-01-12T00:00:00Z'), parentId: 'ghost' }];
    const sited = layoutWorld({ ...src, nodes }, Date.parse('2026-03-06T00:00:00Z'));
    const l1 = sited.byId.get('L1')!;
    for (const k of kids) {
      const p = sited.byId.get(k.id)!;
      expect(p.parentId).toBe('L1');
      expect(Math.hypot(p.x - l1.x, p.z - l1.z)).toBeLessThanOrEqual(l1.siteRadius);
    }
    expect(sited.byId.get('k6')!.ring).toBe(2);
    expect(Math.hypot(sited.byId.get('k6')!.x - l1.x, sited.byId.get('k6')!.z - l1.z)).toBeLessThan(Math.hypot(sited.byId.get('k0')!.x - l1.x, sited.byId.get('k0')!.z - l1.z));
    expect(sited.places).toHaveLength(1 + 2 + nodes.length + 1);
    expect([sited.byId.get('a')!.parentId, sited.byId.get('b')!.parentId].filter(Boolean)).toHaveLength(1);
    expect(sited.byId.get('orphan')!.parentId).toBeNull();
    for (let i = 0; i < sited.places.length; i++) for (let j = i + 1; j < sited.places.length; j++) {
      const a = sited.places[i]!, b = sited.places[j]!;
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(MIN_DISTANCE - .05);
    }
  });

  it('sends a districted hub child to its sector', () => {
    const districted = layoutWorld({ ...src, landmarks: [{ ...src.landmarks[0]!, district: 'to_do' }, { ...src.landmarks[1]!, district: 'done' }], nodes: [{ ...node('loose', '2026-03-05T00:00:00Z', 'hub'), district: 'done' }] });
    expect(districted.districts.map((d) => d.id)).toEqual(['to_do', 'done']);
    const done = districted.districts[1]!;
    for (const id of ['L2', 'loose']) {
      const a = angleOf(districted.byId.get(id)!);
      expect(a).toBeGreaterThanOrEqual(done.from - 1e-9);
      expect(a).toBeLessThanOrEqual(done.to + 1e-9);
    }
  });

  it('marks what moved in the last hour as recent', () => {
    const now = Date.parse('2026-03-06T00:00:00Z');
    const warm = layoutWorld({ ...src, nodes: [{ ...node('new', '2026-03-04T00:00:00Z', 'L1'), activityAt: '2026-03-05T23:30:00Z' }] }, now);
    expect(warm.byId.get('new')?.recent).toBe(true);
    expect(world.byId.get('new')?.recent).toBe(false);
  });
});

describe('graph-driven encounters', () => {
  it('attaches the same live trainer to its session and tasks, with model and relevant messages', () => {
    const session = STORY_FIXTURE.page.sessions.find((s) => s.live && s.taskIds.length)!;
    const view = { ...STORY_FIXTURE, page: { ...STORY_FIXTURE.page, sessions: [{ ...session, model: 'test-model' }] } };
    const world = buildWorld(view);
    const encounter = world.byId.get(session.id)!.encounters[0]!;
    expect(encounter.name).toBe(STORY_FIXTURE.people[session.teamMemberId!]!.name);
    expect(encounter.model).toBe('test-model');
    expect(encounter.phase).toBe('active');
    expect(encounter.total).toBe(session.taskIds.length);
    for (const id of session.taskIds) expect(world.byId.get(id)!.encounters).toContainEqual(encounter);
    for (const row of encounter.activity) {
      const message = view.feed.find((m) => m.id === row.id);
      if (message) expect([session.id, ...session.taskIds]).toContain(message.anchorId);
    }
  });

  it('shows failed and completed work honestly and keeps location fixed across runtime updates', () => {
    const session = STORY_FIXTURE.page.sessions.find((s) => s.taskIds.length)!;
    const make = (failed: boolean) => buildWorld({ ...STORY_FIXTURE, page: {
      ...STORY_FIXTURE.page,
      sessions: [{ ...session, live: false, runtimeStatus: failed ? 'failed' : 'exited' }],
      nodes: STORY_FIXTURE.page.nodes.map((n) => session.taskIds.includes(n.id) ? { ...n, statusCategory: 'done' as const } : n),
    } });
    const failed = make(true), done = make(false);
    expect(failed.byId.get(session.id)!.encounters[0]!.phase).toBe('fainted');
    expect(done.byId.get(session.id)!.encounters[0]!.phase).toBe('victory');
    expect(done.byId.get(session.id)!.encounters[0]!.completed).toBe(session.taskIds.length);
    expect(done.places.map((p) => [p.id, p.x, p.z])).toEqual(failed.places.map((p) => [p.id, p.x, p.z]));
  });
});
