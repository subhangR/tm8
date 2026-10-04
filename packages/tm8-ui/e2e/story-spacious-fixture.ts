/** Fixed graph snapshots shared by the before/after browser audit. No server writes. */
import { STORY_FIXTURE } from '../src/story/fixture';
export function spaciousFixture(count: number) {
  const view = structuredClone(STORY_FIXTURE);
  const roots = view.page.roots.slice(0, count < 20 ? 2 : 5);
  const keep = new Set([view.id, ...roots.map((r) => r.id)]);
  for (const node of view.page.nodes) if (keep.size < count && node.rootIds.some((id) => keep.has(id))) keep.add(node.id);
  view.page.nodes = view.page.nodes.filter((n) => keep.has(n.id));
  view.page.childStories = [];
  view.page.roots = roots.map((r) => ({ ...r, childIds: r.childIds.filter((id) => keep.has(id)), trail: r.trail.filter((t) => keep.has(t.id) && keep.has(t.viaId)) }));
  view.page.edges = view.page.edges.filter((e) => keep.has(e.fromId) && keep.has(e.toId));
  while (view.page.nodes.length < count) {
    const i = view.page.nodes.length, root = view.page.roots[i % roots.length]!;
    const id = `spacious-${i}`;
    view.page.nodes.push({ ...view.page.nodes[1]!, id, title: `Field station ${i}`, rootIds: [root.id], createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), activityAt: null, live: false });
    root.childIds.push(id);
    view.page.edges.push({ id: `edge-${i}`, fromId: root.id, toId: id, type: 'parent', family: 'parent', cross: false, rootIds: [root.id] });
    if (i % 8 === 0) view.page.edges.push({ id: `bridge-${i}`, fromId: `spacious-${i - 1}`, toId: id, type: 'depends_on', family: 'blocks', cross: true, rootIds: [root.id] });
  }
  view.page.sessions = view.page.sessions.filter((s) => keep.has(s.id));
  Object.assign(STORY_FIXTURE, view);
  return STORY_FIXTURE;
}
