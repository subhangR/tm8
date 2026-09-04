/**
 * Contextual grouping — the signal readers and the band layout.
 *
 * Two properties carry this whole feature and are asserted hardest:
 *  - TOTALITY: every node lands in exactly one band, including the nodes the
 *    signal cannot speak about. A grouper that returned nothing for a doc would
 *    make cards vanish, which is indistinguishable from a failed load.
 *  - THE ACCOUNTING LAW under bands, including collapsed ones — the fourth
 *    exclusion bucket must balance exactly like the other three.
 */
import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { GRAPH_FIXTURE_NOW, graphFixtureEdges, graphFixtureNodes } from '../fixtures';
import { buildGraphModel } from './model';
import {
  GROUP_BYS,
  discriminatingGroupBys,
  grouperFor,
  groupSpec,
  type GroupById,
} from './grouping';

const ctx = { now: GRAPH_FIXTURE_NOW, edges: graphFixtureEdges, nodes: graphFixtureNodes };

const DIMENSIONS: GroupById[] = GROUP_BYS.map((g) => g.id).filter((id) => id !== 'none');

const grouped = (groupBy: GroupById, collapsedGroups?: ReadonlySet<string>) =>
  buildGraphModel({
    nodes: graphFixtureNodes,
    edges: graphFixtureEdges,
    kindFilter: null,
    edgeTypeFilter: null,
    now: GRAPH_FIXTURE_NOW,
    lens: 'all',
    groupBy,
    ...(collapsedGroups ? { collapsedGroups } : {}),
  });

describe('the groupers are total', () => {
  it.each(DIMENSIONS)('%s assigns every node exactly one band', (by) => {
    const grouper = grouperFor(by, ctx);
    for (const n of graphFixtureNodes) {
      const a = grouper(n);
      expect(typeof a.key).toBe('string');
      expect(a.key.length).toBeGreaterThan(0);
      // The label is what a human reads — it may never be blank, including on
      // the residual band, whose whole job is to SAY there is nothing to say.
      expect(a.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('is deterministic — the same node yields the same band twice', () => {
    for (const by of DIMENSIONS) {
      const a = grouperFor(by, ctx);
      const b = grouperFor(by, ctx);
      for (const n of graphFixtureNodes) expect(a(n).key).toBe(b(n).key);
    }
  });

  it('names the residual rather than dropping it: a doc has no assignee and says so', () => {
    const grouper = grouperFor('assignee', ctx);
    const withoutAssignees = graphFixtureNodes.filter(
      (n) => !Array.isArray((n.state as { assignees?: unknown[] }).assignees),
    );
    // The fixture is only interesting if it actually contains such a node.
    expect(withoutAssignees.length).toBeGreaterThan(0);
    for (const n of withoutAssignees) {
      const a = grouper(n);
      expect(a.residual).toBe(true);
      expect(a.label).toBe('Unassigned');
    }
  });

  it('groups BY KIND without naming a kind — the band carries kindRef for the registry', () => {
    const grouper = grouperFor('kind', ctx);
    for (const n of graphFixtureNodes) {
      expect(grouper(n).kindRef).toBe(n.kind);
    }
  });

  it('a node with several assignees lands under exactly one, and the label counts the rest', () => {
    const many: EntitySummary = {
      ...graphFixtureNodes[0],
      state: {
        ...(graphFixtureNodes[0].state as object),
        assignees: [
          { id: 'a1', displayName: 'Ada' },
          { id: 'a2', displayName: 'Grace' },
        ],
      } as EntitySummary['state'],
    };
    const a = grouperFor('assignee', ctx)(many);
    expect(a.key).toBe('assignee:a1');
    expect(a.label).toBe('Ada +1');
  });
});

describe('the band layout', () => {
  it('accounts for every node under every dimension — the law holds per band', () => {
    for (const by of DIMENSIONS) {
      const m = grouped(by);
      expect(
        m.placed.length +
          m.shelf.length +
          m.foldedCount +
          m.truncated +
          m.outOfLens +
          m.outOfWindow +
          m.collapsedCount,
      ).toBe(graphFixtureNodes.length);
    }
  });

  it('empties the shelf — a singleton has a band to belong to, so nothing is loose', () => {
    const ungrouped = buildGraphModel({
      nodes: graphFixtureNodes,
      edges: graphFixtureEdges,
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      lens: 'all',
    });
    expect(ungrouped.shelf.length).toBeGreaterThan(0);
    expect(grouped('kind').shelf).toHaveLength(0);
  });

  it('every placed node sits inside its own band frame', () => {
    const m = grouped('status');
    const frame = new Map(m.groups.map((g) => [g.key, g]));
    expect(m.placed.length).toBeGreaterThan(0);
    for (const p of m.placed) {
      const g = frame.get(p.groupKey!)!;
      expect(g).toBeDefined();
      expect(p.x).toBeGreaterThanOrEqual(g.x);
      expect(p.y).toBeGreaterThanOrEqual(g.y);
      expect(p.x + 284).toBeLessThanOrEqual(g.x + g.w);
      expect(p.y + 156).toBeLessThanOrEqual(g.y + g.h);
    }
  });

  it('never overlaps two bands, and never overlaps two cards', () => {
    for (const by of DIMENSIONS) {
      const m = grouped(by);
      // Bands pack into ROWS, so this is a rectangle test, not a vertical one.
      for (let i = 0; i < m.groups.length; i += 1) {
        for (let j = i + 1; j < m.groups.length; j += 1) {
          const a = m.groups[i];
          const b = m.groups[j];
          const overlaps =
            a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlaps).toBe(false);
        }
      }
      const seen = new Set<string>();
      for (const p of m.placed) {
        const key = `${p.x},${p.y}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('packs narrow bands side by side instead of giving each a wasted row', () => {
    // THE DEFECT THIS REPLACED: every band took a full row, so a one-node band
    // reserved as much vertical canvas as a twenty-node one, and the reader
    // scrolled past empty space to reach the next band.
    const m = grouped('kind');
    const rows = new Map<number, number>();
    for (const g of m.groups) rows.set(g.y, (rows.get(g.y) ?? 0) + 1);
    expect(Math.max(...rows.values())).toBeGreaterThan(1);
    // The canvas is strictly shorter than the one-per-row stack would be.
    expect(m.height).toBeLessThan(m.groups.reduce((sum, g) => sum + g.h, 0));
  });

  it('keeps every band inside the reported canvas', () => {
    for (const by of DIMENSIONS) {
      const m = grouped(by);
      for (const g of m.groups) {
        expect(g.x).toBeGreaterThanOrEqual(32);
        expect(g.x + g.w).toBeLessThanOrEqual(m.width);
        expect(g.y + g.h).toBeLessThanOrEqual(m.height);
      }
    }
  });

  it('band counts sum to the placed and collapsed nodes, and each band is non-empty', () => {
    const m = grouped('signal');
    const total = m.groups.reduce((sum, g) => sum + g.count, 0);
    expect(total).toBe(m.placed.length + m.collapsedCount);
    for (const g of m.groups) expect(g.count).toBeGreaterThan(0);
  });

  it('sorts the residual band last however big it is', () => {
    for (const by of DIMENSIONS) {
      const m = grouped(by);
      const firstResidual = m.groups.findIndex((g) => g.residual);
      if (firstResidual === -1) continue;
      for (const g of m.groups.slice(firstResidual)) expect(g.residual).toBe(true);
    }
  });

  it('orders status bands by the workflow, and puts non-workflow statuses after it', () => {
    const keys = grouped('status')
      .groups.filter((g) => !g.residual)
      .map((g) => g.key.slice('status:'.length));
    // The canvas holds more than tasks, and a work_session's `active`/`running`
    // is a lifecycle word, not a WorkStatus. Those are real statuses and are
    // shown as themselves — they simply sort AFTER the workflow, which is what
    // `rankIn` returning `order.length` for an unknown means.
    const WORKFLOW = ['open', 'pulled', 'working', 'blocked', 'in_review', 'done', 'cancelled'];
    const rank = (k: string): number => {
      const i = WORKFLOW.indexOf(k);
      return i === -1 ? WORKFLOW.length : i;
    };
    for (let i = 1; i < keys.length; i += 1) {
      expect(rank(keys[i])).toBeGreaterThanOrEqual(rank(keys[i - 1]));
    }
    // And the workflow statuses really are present and really are in order.
    expect(keys.filter((k) => WORKFLOW.includes(k))).toEqual(['working', 'blocked', 'in_review', 'cancelled']);
  });
});

describe('collapsing a band', () => {
  it('draws the header, places none of its nodes, and counts every one', () => {
    const open = grouped('kind');
    const victim = open.groups[0];
    const m = grouped('kind', new Set([victim.key]));
    const band = m.groups.find((g) => g.key === victim.key)!;

    expect(band.collapsed).toBe(true);
    expect(band.count).toBe(victim.count);
    expect(m.collapsedCount).toBe(victim.count);
    expect(m.placed.some((p) => p.groupKey === victim.key)).toBe(false);
    // The header still occupies the canvas — sizing on nodes alone would clip
    // the only control that brings the contents back.
    expect(band.h).toBeGreaterThan(0);
    expect(m.height).toBeGreaterThanOrEqual(band.y + band.h);
  });

  it('collapsing every band leaves a canvas of headers, and the law still balances', () => {
    const open = grouped('kind');
    const all = new Set(open.groups.map((g) => g.key));
    const m = grouped('kind', all);
    expect(m.placed).toHaveLength(0);
    expect(m.collapsedCount).toBe(open.placed.length);
    expect(
      m.placed.length + m.shelf.length + m.foldedCount + m.truncated +
        m.outOfLens + m.outOfWindow + m.collapsedCount,
    ).toBe(graphFixtureNodes.length);
  });
});

describe('grouping leaves the ungrouped canvas alone', () => {
  it("groupBy 'none' is byte-for-byte the old model", () => {
    const base = buildGraphModel({
      nodes: graphFixtureNodes,
      edges: graphFixtureEdges,
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      lens: 'all',
    });
    const explicit = grouped('none');
    expect(explicit.placed.map((p) => `${p.entity.id}@${p.x},${p.y}`)).toEqual(
      base.placed.map((p) => `${p.entity.id}@${p.x},${p.y}`),
    );
    expect(explicit.groups).toHaveLength(0);
    expect(explicit.collapsedCount).toBe(0);
    expect(explicit.shelf.map((s) => s.id)).toEqual(base.shelf.map((s) => s.id));
  });

  it('draws every edge it drew before — grouping re-homes nodes, it hides nothing', () => {
    const base = grouped('none');
    for (const by of DIMENSIONS) {
      const m = grouped(by);
      expect(new Set(m.edges.map((e) => e.id))).toEqual(new Set(base.edges.map((e) => e.id)));
    }
  });
});

describe('the control only offers what would actually split', () => {
  it('always offers none, and only dimensions yielding two or more bands', () => {
    const offered = discriminatingGroupBys(graphFixtureNodes, ctx);
    expect(offered).toContain('none');
    for (const by of offered) {
      if (by === 'none') continue;
      expect(grouped(by).groups.length).toBeGreaterThan(1);
    }
    for (const by of DIMENSIONS) {
      if (offered.includes(by)) continue;
      expect(grouped(by).groups.length).toBeLessThanOrEqual(1);
    }
  });

  it('a single-node canvas discriminates on nothing', () => {
    const one = [graphFixtureNodes[0]];
    expect(discriminatingGroupBys(one, { ...ctx, nodes: one })).toEqual(['none']);
  });

  it('every dimension has a spec with a hint, and an unknown id falls back to none', () => {
    for (const by of DIMENSIONS) expect(groupSpec(by).hint.length).toBeGreaterThan(0);
    expect(groupSpec('nonsense' as GroupById).id).toBe('none');
  });
});
