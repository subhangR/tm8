/**
 * The flowchart layout — pure, so its promises are checked as INVARIANTS over
 * hand-built and seeded random graphs rather than pinned coordinates:
 * flow reads left→right, cards never overlap, a route starts and ends on its
 * cards' borders, runs orthogonally and never passes under a card, labels
 * never sit on a card or on each other, cycles still place, pins win, an
 * unrelated insertion moves nothing, and ~100 nodes lay out fast.
 */
import { describe, expect, it } from 'vitest';
import {
  isotonic, layoutGraph, roundedPath, segmentHitsBox,
  type Box, type LayoutEdgeInput, type LayoutNodeInput, type LayoutResult, type Point,
} from './layout';

const node = (key: string, extra: Partial<LayoutNodeInput> = {}): LayoutNodeInput =>
  ({ key, width: 200, height: 64, ...extra });
const edge = (from: string, to: string, extra: Partial<LayoutEdgeInput> = {}): LayoutEdgeInput =>
  ({ key: `${from}>${to}`, from, to, ranked: true, label: { width: 60, height: 16 }, ...extra });

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

function onBorder(p: Point, b: Box): boolean {
  const e = 0.6;
  const inX = p.x >= b.x - e && p.x <= b.x + b.width + e;
  const inY = p.y >= b.y - e && p.y <= b.y + b.height + e;
  const onV = Math.abs(p.x - b.x) < e || Math.abs(p.x - (b.x + b.width)) < e;
  const onH = Math.abs(p.y - b.y) < e || Math.abs(p.y - (b.y + b.height)) < e;
  return (onV && inY) || (onH && inX);
}

/** Every structural promise the layout makes, for any input. */
function assertInvariants(result: LayoutResult, nodes: LayoutNodeInput[], edges: LayoutEdgeInput[], dir: 'LR' | 'TB' = 'LR') {
  const boxes = nodes.map((n) => result.nodes.get(n.key)!);
  boxes.forEach((b) => {
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });
  /* No two auto-placed cards overlap. */
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxes[i]!.pinned || boxes[j]!.pinned) continue;
      expect(overlaps(boxes[i]!, boxes[j]!), `${nodes[i]!.key} overlaps ${nodes[j]!.key}`).toBe(false);
    }
  }
  for (const e of edges) {
    const route = result.edges.get(e.key)!;
    expect(route, e.key).toBeDefined();
    const pts = route.points;
    expect(pts.length).toBeGreaterThanOrEqual(2);
    const from = result.nodes.get(e.from)!;
    const to = result.nodes.get(e.to)!;
    if (from.pinned || to.pinned || e.from === e.to) continue;
    /* Ports on the borders, both ends. */
    expect(onBorder(pts[0]!, from), `${e.key} starts on ${e.from}`).toBe(true);
    expect(onBorder(pts[pts.length - 1]!, to), `${e.key} ends on ${e.to}`).toBe(true);
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      /* Orthogonal. */
      expect(Math.abs(p.x - q.x) < 0.01 || Math.abs(p.y - q.y) < 0.01, `${e.key} segment ${i} is diagonal`).toBe(true);
      /* Never under a card — its own two included. */
      boxes.forEach((b, k) => {
        if (b.pinned) return;
        expect(segmentHitsBox(p, q, b), `${e.key} segment ${i} passes under ${nodes[k]!.key}`).toBe(false);
      });
    }
    /* Flow reads forward for every ranked, non-back edge. */
    if (e.ranked && !route.back && !from.pinned && !to.pinned) {
      if (dir === 'LR') expect(from.x + from.width).toBeLessThanOrEqual(to.x);
      else expect(from.y + from.height).toBeLessThanOrEqual(to.y);
    }
  }
  /* Labels: never on a card, never on each other. */
  const labels = edges.map((e) => result.edges.get(e.key)!.labelBox).filter((b): b is Box => b !== null);
  labels.forEach((l, i) => {
    boxes.forEach((b) => expect(overlaps(l, b)).toBe(false));
    labels.slice(i + 1).forEach((m) => expect(overlaps(l, m)).toBe(false));
  });
}

/** Deterministic PRNG so "random" graphs are reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDag(n: number, m: number, seed: number) {
  const rand = mulberry32(seed);
  const sizes = [[200, 64], [168, 56], [160, 36], [120, 28]] as const;
  const nodes = Array.from({ length: n }, (_, i) => {
    const [w, h] = sizes[Math.floor(rand() * sizes.length)]!;
    return node(`n${i}`, { width: w, height: h });
  });
  const edges: LayoutEdgeInput[] = [];
  const seen = new Set<string>();
  while (edges.length < m) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a === b) continue;
    const [from, to] = a < b ? [a, b] : [b, a];
    const key = `n${from}>n${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge(`n${from}`, `n${to}`, { label: { width: 40 + Math.floor(rand() * 40), height: 16 } }));
  }
  return { nodes, edges };
}

describe('isotonic', () => {
  it('is the closest non-decreasing sequence (pool adjacent violators)', () => {
    expect(isotonic([1, 3, 2, 4], [1, 1, 1, 1])).toEqual([1, 2.5, 2.5, 4]);
    expect(isotonic([5, 1], [3, 1])).toEqual([4, 4]);
    expect(isotonic([], [])).toEqual([]);
  });
});

describe('layoutGraph', () => {
  it('lays a pipeline out left to right in rank order', () => {
    const nodes = ['a', 'b', 'c'].map((k) => node(k));
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const r = layoutGraph(nodes, edges);
    expect(['a', 'b', 'c'].map((k) => r.nodes.get(k)!.rank)).toEqual([0, 1, 2]);
    /* A straight chain is drawn straight: one horizontal segment per edge. */
    expect(r.edges.get('a>b')!.points).toHaveLength(2);
    expect(r.crossings).toBe(0);
    assertInvariants(r, nodes, edges);
  });

  it('pulls an input next to the task that consumes it, not into column 0', () => {
    const nodes = ['a', 'b', 'c', 'input'].map((k) => node(k));
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('input', 'c')];
    const r = layoutGraph(nodes, edges);
    expect(r.nodes.get('input')!.rank).toBe(1);
    assertInvariants(r, nodes, edges);
  });

  it('routes a long edge through the gaps, never under the cards it skips', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((k) => node(k));
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('a', 'd')];
    const r = layoutGraph(nodes, edges);
    assertInvariants(r, nodes, edges);
  });

  it('spreads a fan-out across its card side as separate ports', () => {
    const nodes = ['hub', 'x', 'y', 'z'].map((k) => node(k));
    const edges = [edge('hub', 'x'), edge('hub', 'y'), edge('hub', 'z')];
    const r = layoutGraph(nodes, edges);
    const starts = edges.map((e) => r.edges.get(e.key)!.points[0]!.y);
    expect(new Set(starts).size).toBe(3);
    assertInvariants(r, nodes, edges);
  });

  it('places a cycle: one edge runs back, flagged, and everything is still finite and clear', () => {
    const nodes = ['a', 'b', 'c'].map((k) => node(k));
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const r = layoutGraph(nodes, edges);
    expect(edges.filter((e) => r.edges.get(e.key)!.back)).toHaveLength(1);
    const back = r.edges.get('c>a')!;
    expect(back.back).toBe(true);
    /* Drawn in its REAL direction: it ends on `a`. */
    expect(onBorder(back.points[back.points.length - 1]!, r.nodes.get('a')!)).toBe(true);
    assertInvariants(r, nodes, edges);
  });

  it('routes unranked and same-rank links around cards with the generic router', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((k) => node(k));
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'c', { ranked: false }), edge('d', 'a', { ranked: false })];
    const r = layoutGraph(nodes, edges);
    assertInvariants(r, nodes, edges);
  });

  it('is deterministic', () => {
    const { nodes, edges } = randomDag(40, 60, 7);
    expect(layoutGraph(nodes, edges)).toEqual(layoutGraph(nodes, edges));
  });

  it('an unrelated insertion moves nothing already placed', () => {
    const { nodes, edges } = randomDag(25, 35, 11);
    const before = layoutGraph(nodes, edges);
    const after = layoutGraph([...nodes, node('new')], edges);
    nodes.forEach((n) => {
      const a = before.nodes.get(n.key)!;
      const b = after.nodes.get(n.key)!;
      expect([b.x, b.y, b.rank], n.key).toEqual([a.x, a.y, a.rank]);
    });
  });

  it('honours a pin exactly and still routes to it', () => {
    const nodes = [node('a'), node('b', { pinned: { x: 900, y: 500 } }), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const r = layoutGraph(nodes, edges);
    expect(r.nodes.get('b')).toMatchObject({ x: 900, y: 500, pinned: true });
    expect(r.edges.get('a>b')!.points.length).toBeGreaterThanOrEqual(2);
    assertInvariants(r, nodes, edges);
  });

  it('flows top to bottom in TB', () => {
    const nodes = ['a', 'b', 'c'].map((k) => node(k));
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const r = layoutGraph(nodes, edges, { direction: 'TB' });
    expect(r.nodes.get('b')!.y).toBeGreaterThan(r.nodes.get('a')!.y + 64);
    assertInvariants(r, nodes, edges, 'TB');
  });

  it('keeps each lane a contiguous band, in the declared order', () => {
    const nodes = [
      node('t1', { lane: 'ada' }), node('t2', { lane: 'bo' }), node('d1', { lane: 'ada' }),
      node('t3', { lane: 'bo' }), node('t4', { lane: 'ada' }),
    ];
    const edges = [edge('t1', 'd1'), edge('d1', 't2'), edge('t2', 't3'), edge('t1', 't4')];
    const r = layoutGraph(nodes, edges, { lanes: [{ key: 'ada', label: 'Ada' }, { key: 'bo', label: 'Bo' }] });
    expect(r.lanes.map((l) => l.key)).toEqual(['ada', 'bo']);
    const [ada, bo] = r.lanes.map((l) => l.box) as [Box, Box];
    expect(overlaps(ada, bo)).toBe(false);
    expect(ada.y).toBeLessThan(bo.y);
    nodes.forEach((n) => {
      const b = r.nodes.get(n.key)!;
      const lane = n.lane === 'ada' ? ada : bo;
      expect(b.y).toBeGreaterThanOrEqual(lane.y);
      expect(b.y + b.height).toBeLessThanOrEqual(lane.y + lane.height);
    });
    assertInvariants(r, nodes, edges);
  });

  it('keeps every invariant across seeded random plans', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { nodes, edges } = randomDag(18, 26, seed);
      assertInvariants(layoutGraph(nodes, edges), nodes, edges);
      assertInvariants(layoutGraph(nodes, edges, { direction: 'TB' }), nodes, edges, 'TB');
    }
  });

  it('keeps every invariant with cycles, unranked links, lanes and both directions mixed in', () => {
    for (let seed = 100; seed < 130; seed += 1) {
      const rand = mulberry32(seed);
      const { nodes, edges } = randomDag(16, 22, seed);
      /* A few back edges (cycles) and context links that order nothing. */
      for (let i = 0; i < 3; i += 1) {
        const a = 1 + Math.floor(rand() * 15);
        const b = Math.floor(rand() * a);
        edges.push(edge(`n${a}`, `n${b}`, { key: `back${i}:${a}>${b}` }));
      }
      edges.push(edge('n0', 'n9', { key: 'ctx', ranked: false }));
      const laned = nodes.map((n, i) => ({ ...n, lane: ['p', 'q', 'r'][i % 3]! }));
      const lanes = [{ key: 'p', label: 'P' }, { key: 'q', label: 'Q' }, { key: 'r', label: 'R' }];
      for (const direction of ['LR', 'TB'] as const) {
        assertInvariants(layoutGraph(nodes, edges, { direction }), nodes, edges, direction);
        assertInvariants(layoutGraph(laned, edges, { direction, lanes }), laned, edges, direction);
      }
    }
  });

  it('lays out ~100 nodes fast, with every invariant intact', () => {
    const { nodes, edges } = randomDag(100, 140, 42);
    const started = performance.now();
    const r = layoutGraph(nodes, edges);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(250);
    assertInvariants(r, nodes, edges);
  });
});

describe('roundedPath', () => {
  it('rounds each corner and ends exactly on the last point', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d).toContain('Q 100 0');
    expect(d.endsWith('L 100 50')).toBe(true);
    expect(roundedPath([])).toBe('');
  });
});
