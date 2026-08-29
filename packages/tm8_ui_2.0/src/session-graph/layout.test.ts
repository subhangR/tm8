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
import { cellSize, layoutSessionGraph } from './layout';

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

/**
 * One branch carrying twenty-six cells and one carrying three, with every node
 * kept UNDER `HUB_DEGREE` and every relation kept at or under `FOLD_AT` so that
 * neither the hub stop nor the fold quietly rescues the layout — both of which
 * hide this defect if you let them, which is how the first version of the skew
 * test came out green while the bug was live.
 *
 * The heavy branch takes 26/29 of the circle, so `light-a` and `light-b` end up
 * ~0.216 rad apart on a ring that holds only seven cells in total.
 */
function squeezedTree(): Map<string, EdgeView[]> {
  const heavy = entity('heavy', 'task');
  const light = entity('light', 'task');
  const mids = Array.from({ length: 5 }, (_, i) => entity(`mid-${i}`, 'task'));
  const lightA = entity('light-a', 'doc');
  const lightB = entity('light-b', 'doc');

  const edgesByNode = new Map<string, EdgeView[]>([
    [FOCUS, [edge(focusEntity, 'rel_h', heavy), edge(focusEntity, 'rel_l', light)]],
    ['heavy', [
      edge(focusEntity, 'rel_h', heavy),
      ...mids.map((m, i) => edge(heavy, `rel_m${i}`, m)),
    ]],
    ['light', [
      edge(focusEntity, 'rel_l', light),
      edge(light, 'rel_a', lightA),
      edge(light, 'rel_b', lightB),
    ]],
  ]);
  for (const [i, m] of mids.entries()) {
    const kids = Array.from({ length: 4 }, (_, k) => entity(`deep-${i}-${k}`, 'doc'));
    edgesByNode.set(m.id, [
      edge(heavy, `rel_m${i}`, m),
      ...kids.map((k, j) => edge(m, `deep_rel_${j}`, k)),
    ]);
  }
  return edgesByNode;
}

/**
 * Every unordered pair of placed cells whose BOXES intersect. Sizes come from
 * `cellSize`, not from a constant: the focus is drawn larger than its
 * neighbours, and measuring it at a child's width would let the one card that
 * overlaps most easily pass.
 */
function overlaps(placement: ReturnType<typeof layoutSessionGraph>): string[] {
  const hits: string[] = [];
  const cells = placement.cells;
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      const a = cells[i]!;
      const b = cells[j]!;
      const sa = cellSize(a.cell.hop);
      const sb = cellSize(b.cell.hop);
      if (
        Math.abs(a.x - b.x) < (sa.w + sb.w) / 2 &&
        Math.abs(a.y - b.y) < (sa.h + sb.h) / 2
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

  /**
   * PEER REVIEW, GPT 5.6, 2026-08-15 — the case above is not the hard one, and
   * a green test on it was evidence of nothing.
   *
   * A sector is INHERITED: a child is placed inside its parent's sector, so a
   * branch that was squeezed at hop 1 stays squeezed at every hop below it,
   * however few cells that ring holds in total. Here hop 2 holds three cells —
   * an occupancy radius reads that as "almost empty" — but two of them are
   * sharing the 2/22 of the circle their parent was given, and they land on top
   * of each other. The twenty hop-3 leaves fail the other way: their angular
   * gap is wide enough, but the cards are AXIS-ALIGNED, so near the top of the
   * circle a generous arc still leaves almost no separation in x.
   *
   * Both say the same thing: circumference ÷ count is not a collision test.
   */
  it('never overlaps in a sector inherited from a squeezed parent', () => {
    const placement = layoutSessionGraph(buildSessionGraph({
      focusId: FOCUS,
      focus: focusEntity,
      edgesByNode: squeezedTree(),
      hops: 3,
    }));
    expect(overlaps(placement)).toEqual([]);
  });

  it('sizes that ring by its tightest pair, not by how many it holds', () => {
    // The mechanism, not just the symptom. Hop 2 holds SEVEN cells, which by
    // circumference ÷ count needs about 270 and so would have been handed the
    // 484 floor — the number that produced the overlap above. A ring sized by
    // its narrowest gap must come out far beyond that; if this ever drops back
    // to the floor, the averaging has returned and the test above will only
    // catch it if someone happens to re-run this exact topology.
    const { radii } = layoutSessionGraph(buildSessionGraph({
      focusId: FOCUS,
      focus: focusEntity,
      edgesByNode: squeezedTree(),
      hops: 3,
    }));
    expect(radii[1]!).toBeGreaterThan(radii[0]! * 3);
  });

  /**
   * The focus is drawn larger than its neighbours, and a lone child sits at
   * EXACTLY its parent's angle — so with one hop-1 cell the first radius is the
   * only thing holding the two apart, and it is sized against a box no other
   * pair on the canvas has. A ring floor derived from the child's width alone
   * would put the first card inside the focus card.
   */
  it('clears the focus, which is larger than everything around it', () => {
    expect(overlaps(busyRing(1))).toEqual([]);
    expect(overlaps(busyRing(2))).toEqual([]);
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
