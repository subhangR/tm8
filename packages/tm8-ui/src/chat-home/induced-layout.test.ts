// @vitest-environment jsdom
/**
 * P3 — layout acceptance, straight from the design doc: no two cards overlap
 * at n = 3, 10, 24 with the real card size; identical input twice produces
 * identical coordinates; and a settled card never moves when nodes or EDGES
 * arrive later (edges land asynchronously after their endpoints settle).
 */
import { describe, expect, it } from 'vitest';
import { buildInducedGraph, type GraphSeed, type SeedConnections } from './induced-graph';
import { CARD_H, CARD_W, layoutInducedGraph } from './induced-layout';
import { edgeOf, measuredConnections, measuredSeeds } from './induced-graph.fixture';

const id = (n: number): string => `01900000-00bb-7000-8000-${String(n).padStart(12, '0')}`;
const seedsOf = (n: number): GraphSeed[] =>
  Array.from({ length: n }, (_, i) => ({ id: id(i + 1), mutated: false }));

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  // The honest axis-aligned test (session-graph layout.ts): clear iff
  // |Δx| ≥ w or |Δy| ≥ h. Overlap is its negation.
  return Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H;
}

describe('layoutInducedGraph', () => {
  it.each([3, 10, 24])('no two cards overlap at n = %i', (n) => {
    const { cards } = layoutInducedGraph(buildInducedGraph(seedsOf(n), new Map()));
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        expect(overlaps(cards[i]!, cards[j]!)).toBe(false);
      }
    }
    expect(cards).toHaveLength(n);
  });

  it('R10: the measured fixture lays out byte-identically twice', () => {
    const a = layoutInducedGraph(buildInducedGraph(measuredSeeds(), measuredConnections()));
    const b = layoutInducedGraph(buildInducedGraph(measuredSeeds(), measuredConnections()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('R9: a settled card does not move when a NEW NODE arrives', () => {
    const before = layoutInducedGraph(buildInducedGraph(seedsOf(5), new Map()));
    const after = layoutInducedGraph(buildInducedGraph(seedsOf(6), new Map()));
    for (let i = 0; i < 5; i += 1) {
      expect(after.cards[i]!.x).toBe(before.cards[i]!.x);
      expect(after.cards[i]!.y).toBe(before.cards[i]!.y);
    }
  });

  it('R9: a settled card does not move when an EDGE arrives between settled nodes', () => {
    const seeds = seedsOf(2);
    const none = layoutInducedGraph(buildInducedGraph(seeds, new Map()));
    const withEdge = layoutInducedGraph(
      buildInducedGraph(
        seeds,
        new Map<string, SeedConnections>([
          [
            seeds[0]!.id,
            { state: 'loaded', edges: [edgeOf(seeds[0]!.id, 'relates_to', seeds[1]!.id)], pageCapped: false },
          ],
        ]),
      ),
    );
    expect(withEdge.cards.map((c) => [c.x, c.y])).toEqual(none.cards.map((c) => [c.x, c.y]));
    expect(withEdge.lines).toHaveLength(1);
  });

  it('lines connect the centres of their endpoint cards, beneath which they draw', () => {
    const graph = buildInducedGraph(measuredSeeds(), measuredConnections());
    const placement = layoutInducedGraph(graph);
    const centres = new Map(
      placement.cards.map((card) => [card.node.id, { x: card.x + CARD_W / 2, y: card.y + CARD_H / 2 }]),
    );
    expect(placement.lines).toHaveLength(graph.edges.length);
    for (const line of placement.lines) {
      const a = centres.get(line.edge.a)!;
      const b = centres.get(line.edge.b)!;
      expect([line.x1, line.y1]).toEqual([a.x, a.y]);
      expect([line.x2, line.y2]).toEqual([b.x, b.y]);
    }
  });

  it('the canvas box contains every card', () => {
    for (const n of [1, 4, 10, 24]) {
      const placement = layoutInducedGraph(buildInducedGraph(seedsOf(n), new Map()));
      for (const card of placement.cards) {
        expect(card.x).toBeGreaterThanOrEqual(0);
        expect(card.y).toBeGreaterThanOrEqual(0);
        expect(card.x + CARD_W).toBeLessThanOrEqual(placement.width);
        expect(card.y + CARD_H).toBeLessThanOrEqual(placement.height);
      }
    }
  });

  describe('perRow option (fullscreen hosts pass their own column count)', () => {
    it('defaults stay byte-identical: no option ≡ perRow 4', () => {
      const graph = buildInducedGraph(measuredSeeds(), measuredConnections());
      expect(JSON.stringify(layoutInducedGraph(graph))).toBe(
        JSON.stringify(layoutInducedGraph(graph, { perRow: 4 })),
      );
    });

    it.each([4, 8, 12])('deterministic, no overlap, contained at perRow = %i', (perRow) => {
      const graph = buildInducedGraph(seedsOf(24), new Map());
      const a = layoutInducedGraph(graph, { perRow });
      const b = layoutInducedGraph(graph, { perRow });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      for (let i = 0; i < a.cards.length; i += 1) {
        for (let j = i + 1; j < a.cards.length; j += 1) {
          expect(overlaps(a.cards[i]!, a.cards[j]!)).toBe(false);
        }
      }
      for (const card of a.cards) {
        expect(card.x).toBeGreaterThanOrEqual(0);
        expect(card.y).toBeGreaterThanOrEqual(0);
        expect(card.x + CARD_W).toBeLessThanOrEqual(a.width);
        expect(card.y + CARD_H).toBeLessThanOrEqual(a.height);
      }
    });

    it('a wider row uses width for height: 24 cards at 8-up sit in 3 rows, not 6', () => {
      const graph = buildInducedGraph(seedsOf(24), new Map());
      const narrow = layoutInducedGraph(graph, { perRow: 4 });
      const wide = layoutInducedGraph(graph, { perRow: 8 });
      expect(wide.width).toBeGreaterThan(narrow.width);
      expect(wide.height).toBeLessThan(narrow.height);
      const rowsOf = (p: typeof wide) => new Set(p.cards.map((c) => c.y)).size;
      expect(rowsOf(narrow)).toBe(6);
      expect(rowsOf(wide)).toBe(3);
    });

    it('R9 holds at any perRow: a settled card never moves as nodes arrive', () => {
      const before = layoutInducedGraph(buildInducedGraph(seedsOf(9), new Map()), { perRow: 8 });
      const after = layoutInducedGraph(buildInducedGraph(seedsOf(10), new Map()), { perRow: 8 });
      for (let i = 0; i < 9; i += 1) {
        expect(after.cards[i]!.x).toBe(before.cards[i]!.x);
        expect(after.cards[i]!.y).toBe(before.cards[i]!.y);
      }
    });
  });
});
