/**
 * Gate L4 (graph): the pure view-model — dependency mode marks the seeded
 * blocked path red (T-105 —hard→ T-104), containment clusters collapse,
 * saved layouts stick, hover dims the non-neighborhood.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { blockedEdges, buildGraphView, collectLayout, edgeLabel } from '../../collections';
import type { GraphResult } from '../../types/contract';
import { createFacade, resetStores } from './helpers';

describe('graph view model', () => {
  beforeEach(resetStores);

  async function seededGraph(mode: 'free' | 'dependency'): Promise<{ facade: ReturnType<typeof createFacade>; result: GraphResult }> {
    const facade = createFacade();
    const result = await facade.queryGraph({
      spaceId: facade.ids.space, kinds: ['task'], sort: 'position', mode,
    });
    return { facade, result };
  }

  it('dependency mode: the seeded T-105 → T-104 hard dep is the red blocked path', async () => {
    const { facade, result } = await seededGraph('dependency');
    // only depends_on edges survive dependency mode
    expect(result.edges.every((e) => e.type === 'depends_on')).toBe(true);

    const view = buildGraphView(result, { mode: 'dependency' });
    const red = view.edges.filter((e) => e.blocked);
    expect(red).toHaveLength(1);
    expect(red[0].source).toBe(facade.ids.t105);
    expect(red[0].target).toBe(facade.ids.t104);
    expect(view.blockedNodeIds).toEqual(new Set([facade.ids.t105, facade.ids.t104]));

    // resolved dep (T-106 → T-101, T-101 is done) is NOT red
    const resolved = view.edges.find((e) => e.source === facade.ids.t106 && e.target === facade.ids.t101);
    expect(resolved?.blocked).toBe(false);

    // soft dep (T-107 → T-106) never blocks
    const soft = view.edges.find((e) => e.source === facade.ids.t107);
    expect(soft?.blocked).toBe(false);
    expect(soft?.hard).toBe(false);

    const t105 = view.nodes.find((n) => n.id === facade.ids.t105);
    const t104 = view.nodes.find((n) => n.id === facade.ids.t104);
    expect(t105?.data.onBlockedPath).toBe(true);
    expect(t104?.data.onBlockedPath).toBe(true);
  });

  it('dependency mode ranks topologically left-to-right (prerequisite left of dependent)', async () => {
    const { facade, result } = await seededGraph('dependency');
    const view = buildGraphView(result, { mode: 'dependency' });
    const x = (id: string): number => view.nodes.find((n) => n.id === id)!.position.x;
    // T-104 must be done before T-105 → it sits left of T-105
    expect(x(facade.ids.t104)).toBeLessThan(x(facade.ids.t105));
    expect(x(facade.ids.t101)).toBeLessThan(x(facade.ids.t106));
    // dependency mode is the untangling view: no containment boxes
    expect(view.nodes.every((n) => n.type === 'cv2Entity')).toBe(true);
  });

  it('free mode: hierarchy renders as containment clusters, distinct from edges', async () => {
    const { facade, result } = await seededGraph('free');
    const view = buildGraphView(result, { mode: 'free' });
    const clusters = view.nodes.filter((n) => n.type === 'cv2Cluster');
    expect(clusters.map((c) => c.id)).toEqual(
      expect.arrayContaining([`cluster:${facade.ids.t100}`, `cluster:${facade.ids.t103}`]),
    );
    // nesting: T-103's cluster sits inside T-100's cluster
    const inner = clusters.find((c) => c.id === `cluster:${facade.ids.t103}`);
    expect(inner?.parentId).toBe(`cluster:${facade.ids.t100}`);
    // children are parented into their containment box
    const t103a = view.nodes.find((n) => n.id === facade.ids.t103a);
    expect(t103a?.parentId).toBe(`cluster:${facade.ids.t103}`);
    // the cluster parent card carries the expanded-cluster affordance
    const t103 = view.nodes.find((n) => n.id === facade.ids.t103);
    expect(t103?.data.clusterParent).toBe(true);
  });

  it('collapsing a cluster hides its descendants and remaps edges onto the parent', async () => {
    const { facade, result } = await seededGraph('free');

    const collapsedInner = buildGraphView(result, { mode: 'free', collapsed: [facade.ids.t103] });
    const ids = new Set(collapsedInner.nodes.map((n) => n.id));
    expect(ids.has(facade.ids.t103a)).toBe(false);
    expect(ids.has(facade.ids.t103b)).toBe(false);
    expect(ids.has(facade.ids.t103)).toBe(true);
    const t103 = collapsedInner.nodes.find((n) => n.id === facade.ids.t103);
    expect(t103?.data.collapsed).toBe(true);
    expect(t103?.data.hiddenCount).toBe(2);
    expect(ids.has(`cluster:${facade.ids.t103}`)).toBe(false);

    // collapsing the milestone hides the WHOLE subtree (transitively), and the
    // T-105→T-104 edge (both endpoints hidden) disappears rather than dangling
    const collapsedRoot = buildGraphView(result, { mode: 'free', collapsed: [facade.ids.t100] });
    const rootIds = new Set(collapsedRoot.nodes.map((n) => n.id));
    expect(rootIds.has(facade.ids.t103a)).toBe(false);
    expect(rootIds.has(facade.ids.t105)).toBe(false);
    expect(rootIds.has(facade.ids.t100)).toBe(true);
    expect(collapsedRoot.edges.some(
      (e) => e.source === facade.ids.t105 || e.target === facade.ids.t104,
    )).toBe(false);
  });

  it('a saved layout overrides dagre for the nodes it knows', async () => {
    const { facade, result } = await seededGraph('free');
    const savedLayout = { [facade.ids.t105]: { x: 999, y: 111 } };
    const view = buildGraphView(result, { mode: 'free', savedLayout });
    const t105 = view.nodes.find((n) => n.id === facade.ids.t105);
    expect(t105?.position).toEqual({ x: 999, y: 111 });
    // hand-arranged layouts are flat: no containment boxes to fight the user
    expect(view.nodes.every((n) => n.type === 'cv2Entity')).toBe(true);
  });

  it('hover dims everything outside the neighborhood', async () => {
    const { facade, result } = await seededGraph('dependency');
    const view = buildGraphView(result, { mode: 'dependency', hoverId: facade.ids.t105 });
    const dimmedOf = (id: string): boolean | undefined => view.nodes.find((n) => n.id === id)?.data.dimmed;
    expect(dimmedOf(facade.ids.t105)).toBe(false);
    expect(dimmedOf(facade.ids.t104)).toBe(false);  // direct neighbor
    expect(dimmedOf(facade.ids.t107)).toBe(true);   // unrelated
    const unrelated = view.edges.find((e) => e.source === facade.ids.t107);
    expect(unrelated?.dimmed).toBe(true);
  });

  it('edge labels are typed and hardness-aware; blockedEdges is the red set', async () => {
    const { result } = await seededGraph('free');
    const hard = result.edges.find((e) => e.type === 'depends_on' && e.hard !== false);
    const soft = result.edges.find((e) => e.type === 'depends_on' && e.hard === false);
    expect(hard && edgeLabel(hard)).toBe('depends on · hard');
    expect(soft && edgeLabel(soft)).toBe('depends on · soft');
    expect(blockedEdges(result.edges)).toHaveLength(1);
  });

  it('collectLayout resolves container-relative positions to absolute', () => {
    const layout = collectLayout([
      { id: 'cluster:a', position: { x: 100, y: 50 } },
      { id: 'n1', position: { x: 10, y: 20 }, parentId: 'cluster:a' },
      { id: 'n2', position: { x: 400, y: 300 } },
    ]);
    expect(layout.n1).toEqual({ x: 110, y: 70 });
    expect(layout.n2).toEqual({ x: 400, y: 300 });
    expect(layout['cluster:a']).toBeUndefined();
  });
});
