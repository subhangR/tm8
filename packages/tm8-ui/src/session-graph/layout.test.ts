/**
 * The radial placement's one hard obligation: cells on the same ring must not
 * sit on top of each other. It was survivable to hard-code the radii while a
 * cell was 148x40 and a hop held four or five things; at 216 wide a busy hop
 * stacked its peers into an unreadable pile, which is the same defect as the
 * too-small card arriving from the other direction. Radii are now derived from
 * ring occupancy, and this file is what keeps them derived.
 */
import { describe, expect, it } from 'vitest';
import type { EdgeView, EntitySummary } from '@tm8/contract';
import { buildSessionGraph } from './model';
import { NODE_H, NODE_W, layoutSessionGraph } from './layout';

const FOCUS = 'session-1';

function entity(id: string, kind = 'doc'): EntitySummary {
  return {
    id,
    spaceId: 'space-1',
    kind,
    title: id,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    deletedAt: null,
    createdBy: { kind: 'member', id: 'm1', displayName: 'M' },
    counters: {},
    state: {},
    badges: {},
  } as unknown as EntitySummary;
}

function edge(from: EntitySummary, type: string, to: EntitySummary): EdgeView {
  return {
    id: `${from.id}-${type}-${to.id}`,
    type,
    source: from,
    target: to,
    props: {},
    createdBy: { kind: 'member', id: 'm1', displayName: 'M' },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  } as unknown as EdgeView;
}

const focusEntity = entity(FOCUS, 'work_session');

/**
 * `n` peers on hop 1, each under its own relation type so nothing folds — the
 * worst case the ring has to seat.
 */
function busyRing(n: number) {
  const peers = Array.from({ length: n }, (_, i) => entity(`peer-${i}`, 'task'));
  const edges = peers.map((peer, i) => edge(focusEntity, `rel_${i}`, peer));
  return layoutSessionGraph(
    buildSessionGraph({
      focusId: FOCUS,
      focus: focusEntity,
      edgesByNode: new Map([[FOCUS, edges]]),
      hops: 1,
    }),
  );
}

/** Every unordered pair of placed cells that overlap as NODE_W x NODE_H boxes. */
function overlaps(placement: ReturnType<typeof layoutSessionGraph>): string[] {
  const hits: string[] = [];
  const cells = placement.cells;
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      const a = cells[i]!;
      const b = cells[j]!;
      if (
        Math.abs(a.x - b.x) < NODE_W &&
        Math.abs(a.y - b.y) < NODE_H
      ) {
        hits.push(`${a.cell.id}/${b.cell.id}`);
      }
    }
  }
  return hits;
}

describe('ring radii are derived from occupancy', () => {
  it('never overlaps two cells, however busy the hop', () => {
    for (const n of [2, 4, 8, 14, 20]) {
      expect(overlaps(busyRing(n))).toEqual([]);
    }
  });

  it('pushes a busy ring outward instead of piling cells up', () => {
    const quiet = busyRing(3).radii[0]!;
    const busy = busyRing(20).radii[0]!;
    expect(busy).toBeGreaterThan(quiet);
    // ...and the canvas grows with it, so the fit-to-view never crops a ring.
    expect(busyRing(20).width).toBeGreaterThan(busyRing(3).width);
  });

  it('keeps a quiet graph compact rather than scaling to the worst case', () => {
    // Three peers must not be spread over the radius twenty would need.
    expect(busyRing(3).radii[0]!).toBeLessThan(busyRing(20).radii[0]! / 2);
  });

  /**
   * The occupancy radius divides a ring's circumference by how many cells the
   * WHOLE ring holds, but placement hands each branch a sector proportional to
   * its subtree weight — so a ring's cells are not evenly spread and an average
   * can pass while one crowded sector overlaps. This is the skewed case: one
   * hop-1 branch carrying every hop-2 child, and one carrying none.
   */
  it('never overlaps inside a crowded sector of an uneven tree', () => {
    for (const n of [4, 8, 16]) {
      const heavy = entity('heavy', 'task');
      const light = entity('light', 'task');
      const kids = Array.from({ length: n }, (_, i) => entity(`kid-${i}`, 'doc'));
      const edgesByNode = new Map<string, EdgeView[]>([
        [FOCUS, [edge(focusEntity, 'rel_h', heavy), edge(focusEntity, 'rel_l', light)]],
      ]);
      // Each child under its own relation type so the fold never rescues us.
      edgesByNode.set('heavy', [
        edge(focusEntity, 'rel_h', heavy),
        ...kids.map((k, i) => edge(heavy, `kid_rel_${i}`, k)),
      ]);
      edgesByNode.set('light', [edge(focusEntity, 'rel_l', light)]);
      const placement = layoutSessionGraph(
        buildSessionGraph({ focusId: FOCUS, focus: focusEntity, edgesByNode, hops: 2 }),
      );
      expect(overlaps(placement)).toEqual([]);
    }
  });

  it('never draws a ring inside the one before it', () => {
    const peers = Array.from({ length: 4 }, (_, i) => entity(`peer-${i}`, 'task'));
    const deep = peers.map((p, i) => entity(`deep-${i}`, 'doc'));
    const edgesByNode = new Map<string, EdgeView[]>([
      [FOCUS, peers.map((p, i) => edge(focusEntity, `rel_${i}`, p))],
    ]);
    for (const [i, p] of peers.entries()) {
      edgesByNode.set(p.id, [
        edge(focusEntity, `rel_${i}`, p),
        edge(p, 'relates_to', deep[i]!),
      ]);
    }
    const { radii } = layoutSessionGraph(
      buildSessionGraph({ focusId: FOCUS, focus: focusEntity, edgesByNode, hops: 2 }),
    );
    expect(radii.length).toBeGreaterThan(1);
    for (let i = 1; i < radii.length; i += 1) {
      expect(radii[i]!).toBeGreaterThan(radii[i - 1]!);
    }
  });
});
