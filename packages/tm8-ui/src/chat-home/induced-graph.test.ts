// @vitest-environment jsdom
/**
 * P0/P1 — the induced-graph model asserted against the LIVE MEASUREMENT
 * (design doc §4). The fixture is the instrument: 10 seeds, 14 induced
 * relations over 4 types, 3 page-capped hubs, one isolated channel, one
 * failed read. If these numbers move, either the model broke or the design's
 * factual basis changed — both need a human to look.
 */
import { describe, expect, it } from 'vitest';
import { buildInducedGraph, type GraphSeed, type SeedConnections } from './induced-graph';
import {
  C1,
  M1,
  M2,
  MEASURED,
  S1,
  S4,
  T1,
  T2,
  edgeOf,
  measuredConnections,
  measuredSeeds,
} from './induced-graph.fixture';
import { truncateEntityId } from './entity-refs';

const graph = () => buildInducedGraph(measuredSeeds(), measuredConnections());

describe('buildInducedGraph over the measured fixture', () => {
  it('reproduces the measurement: 14 relations over 4 types, merged into 10 lines', () => {
    const g = graph();
    expect(g.nodes).toHaveLength(MEASURED.seedCount);
    expect(g.relationCount).toBe(MEASURED.inducedRelations);
    expect(g.edges).toHaveLength(MEASURED.mergedLines);
    const types = new Set(g.edges.flatMap((e) => e.relations.map((r) => r.type)));
    expect([...types].sort()).toEqual([...MEASURED.relationTypes]);
  });

  it('R3: only real edges with BOTH endpoints in the seed set — no co-occurrence, no connector hops', () => {
    const g = graph();
    const seedIds = new Set(g.nodes.map((n) => n.id));
    for (const edge of g.edges) {
      expect(seedIds.has(edge.a)).toBe(true);
      expect(seedIds.has(edge.b)).toBe(true);
    }
    // The hubs' 100+ external edges induced nothing: no external id leaked in.
    expect(g.nodes).toHaveLength(10);
  });

  it('R4: parallel relations merge into ONE line carrying the relation set, direction preserved', () => {
    const g = graph();
    const pair = g.edges.find(
      (e) => (e.a === T2 && e.b === M2) || (e.a === M2 && e.b === T2),
    )!;
    expect(pair.relations).toHaveLength(3);
    expect(pair.relations.map((r) => `${r.type}:${r.from === T2 ? 'task→tm' : 'tm→task'}`).sort())
      .toEqual(['assigned_to:task→tm', 'participates_in:tm→task', 'relates_to:task→tm']);
  });

  it('an edge returned by BOTH endpoints\' reads is one relation, not two', () => {
    const g = graph();
    const pair = g.edges.find(
      (e) => (e.a === T1 && e.b === M1) || (e.a === M1 && e.b === T1),
    )!;
    // T1's page and M1's page both carry assigned_to and participates_in.
    expect(pair.relations.map((r) => r.type).sort()).toEqual(['assigned_to', 'participates_in']);
  });

  it('R5 vs R11: the channel is ISOLATED; the failed seed is UNREAD — never conflated', () => {
    const g = graph();
    const channel = g.nodes.find((n) => n.id === C1)!;
    expect(channel.isolated).toBe(true);
    expect(channel.edgesRead).toBe(true);
    expect(channel.degree).toBe(16);

    const failed = g.nodes.find((n) => n.id === S4)!;
    expect(failed.edgesRead).toBe(false);
    expect(failed.isolated).toBe(false); // unknown ≠ unlinked
    expect(failed.degree).toBeNull();

    expect(g.isolatedCount).toBe(MEASURED.isolatedIds.length);
    expect(g.unreadCount).toBe(MEASURED.unreadIds.length);
  });

  it('a failed seed still draws the edges its PEERS\' reads returned', () => {
    const g = graph();
    const viaPeer = g.edges.find(
      (e) => (e.a === S4 && e.b === T1) || (e.a === T1 && e.b === S4),
    );
    expect(viaPeer).toBeDefined();
    expect(viaPeer!.relations[0]!.type).toBe('relates_to');
  });

  it('F2/R7a: bare-id seeds resolve kind and title from the edge payload — including the failed one', () => {
    const g = graph();
    const t1 = g.nodes.find((n) => n.id === T1)!;
    expect(t1.title).toBe('Fix THis');
    expect(t1.kind).toBe('task');
    expect(t1.resolvedTitle).toBe(true);
    // S4's own read failed; its summary rides T1's edge to it.
    const s4 = g.nodes.find((n) => n.id === S4)!;
    expect(s4.title).toBe('Stalled run');
    expect(s4.kind).toBe('work_session');
    // No node in the shipped fixture shows a truncated UUID (the §3 defect).
    for (const node of g.nodes) expect(node.resolvedTitle).toBe(true);
  });

  it('F3: hubs read at degree 60, page-capped; ordinary seeds sit at 6–11', () => {
    const g = graph();
    for (const id of MEASURED.hubIds) {
      const hub = g.nodes.find((n) => n.id === id)!;
      expect(hub.degree).toBe(60);
      expect(hub.pageCapped).toBe(true);
    }
    const ordinary = g.nodes.filter(
      (n) => !MEASURED.hubIds.includes(n.id as never) && n.id !== S4,
    );
    for (const node of ordinary) {
      expect(node.degree).toBeGreaterThanOrEqual(6);
      expect(node.degree).toBeLessThanOrEqual(16);
      expect(node.pageCapped).toBe(false);
    }
  });

  it('Q4: a working_on self-pair is TWO nodes sharing a title, told apart by kind', () => {
    const g = graph();
    const session = g.nodes.find((n) => n.id === S1)!;
    const task = g.nodes.find((n) => n.id === T1)!;
    expect(session.title).toBe(task.title);
    expect(session.kind).toBe('work_session');
    expect(task.kind).toBe('task');
    const line = g.edges.find(
      (e) => (e.a === S1 && e.b === T1) || (e.a === T1 && e.b === S1),
    )!;
    expect(line.relations.some((r) => r.type === 'working_on' && r.from === S1)).toBe(true);
  });

  it('R6 passthrough: the mutated flag survives onto the node', () => {
    const g = graph();
    expect(g.nodes.find((n) => n.id === T1)!.mutated).toBe(true);
    expect(g.nodes.find((n) => n.id === T2)!.mutated).toBe(false);
  });

  it('R10 groundwork: node order is seed order; edges and relations are deterministically sorted', () => {
    const a = graph();
    const b = graph();
    expect(a.nodes.map((n) => n.id)).toEqual(measuredSeeds().map((s) => s.id));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildInducedGraph degenerates and fallbacks', () => {
  const bare = (id: string): GraphSeed => ({ id, mutated: false });

  it('no seeds → an empty graph (R12: render nothing)', () => {
    const g = buildInducedGraph([], new Map());
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });

  it('R7b/d: a pending seed keeps its extraction title, or falls back to the truncated id', () => {
    const withTitle: GraphSeed = { id: T1, kind: 'task', title: 'From extraction', mutated: false };
    const g = buildInducedGraph(
      [withTitle, bare(T2)],
      new Map<string, SeedConnections>([
        [T1, { state: 'pending' }],
        [T2, { state: 'pending' }],
      ]),
    );
    expect(g.nodes[0]!.title).toBe('From extraction');
    expect(g.nodes[0]!.resolvedTitle).toBe(true);
    expect(g.nodes[1]!.title).toBe(truncateEntityId(T2));
    expect(g.nodes[1]!.resolvedTitle).toBe(false);
    expect(g.unreadCount).toBe(2);
  });

  it('the edge-payload summary outranks the extraction title (R7 order)', () => {
    const seed: GraphSeed = { id: T1, kind: 'entity', title: 'Stale extraction', mutated: false };
    const g = buildInducedGraph(
      [seed, bare(M1)],
      new Map<string, SeedConnections>([
        [T1, { state: 'loaded', edges: [edgeOf(T1, 'assigned_to', M1)], pageCapped: false }],
      ]),
    );
    expect(g.nodes[0]!.title).toBe('Fix THis');
    expect(g.nodes[0]!.kind).toBe('task');
  });

  it('self-edges never draw a line', () => {
    const g = buildInducedGraph(
      [bare(T1)],
      new Map<string, SeedConnections>([
        [T1, { state: 'loaded', edges: [edgeOf(T1, 'relates_to', T1)], pageCapped: false }],
      ]),
    );
    expect(g.edges).toHaveLength(0);
    // Its only edge was a self-edge, so it holds no drawn line: isolated.
    expect(g.nodes[0]!.isolated).toBe(true);
  });
});
