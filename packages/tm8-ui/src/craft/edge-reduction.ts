/**
 * EDGE REDUCTION — which of a craft graph's edges the canvas DRAWS. View-only:
 * the row keeps every edge; lists, the table and the inspector still read them
 * all. Pure and deterministic (input order breaks every tie).
 *
 * Levels (`BlueprintEdgeDetail`):
 *   - 'all'       every edge is a line.
 *   - 'reduced'   parallel edges (same drawn pair) merge into ONE line,
 *                 and an ordering edge another path already implies is not
 *                 drawn (transitive reduction: A→C goes when A→B→C exists).
 *   - 'essential' 'reduced', and context links (relates to, remembers, uses
 *                 skill) fold away too.
 *
 * Only edges marked `reducible` (pure ordering — `depends_on`) are ever dropped
 * as implied; a `produces`/`consumes` line says WHAT flows, so it stays even
 * when a path covers it. Any ranked edge can be part of the covering path, in
 * DRAWN direction (what the eye follows). Edges are removed one at a time,
 * each only while its endpoints stay connected without it, so reachability is
 * exactly preserved — a cycle is never cut open.
 */
import type { BlueprintEdgeDetail } from './blueprint-types';

export interface ReducibleEdge {
  key: string;
  /** Drawn direction. */
  from: string;
  to: string;
  /** Orders the flow — may be part of a path that implies another edge. */
  ranked: boolean;
  /** May be dropped when a path implies it. */
  reducible: boolean;
  /** Folds away at 'essential'. */
  fold: boolean;
}

export interface EdgeReduction {
  /** Keys still drawn, in input order. */
  kept: string[];
  /** Merged-away key → the kept key whose line now carries it. */
  mergedInto: Map<string, string>;
  /** Kept key → every key its line carries (itself first). */
  carries: Map<string, string[]>;
  /** Not drawn: another path implies them. */
  implied: Set<string>;
  /** Not drawn: context links folded at 'essential'. */
  folded: Set<string>;
}

export function reduceEdges(edges: readonly ReducibleEdge[], detail: BlueprintEdgeDetail): EdgeReduction {
  const mergedInto = new Map<string, string>();
  const carries = new Map<string, string[]>();
  const implied = new Set<string>();
  const folded = new Set<string>();
  if (detail === 'all') {
    edges.forEach((e) => carries.set(e.key, [e.key]));
    return { kept: edges.map((e) => e.key), mergedInto, carries, implied, folded };
  }

  // ── Fold ────────────────────────────────────────────────────────────────────
  const visible = edges.filter((e) => {
    if (detail === 'essential' && e.fold) folded.add(e.key);
    return !folded.has(e.key);
  });

  // ── Merge parallel edges ────────────────────────────────────────────────────
  /* Same drawn pair and direction. An UNRANKED edge (relates to) has no real
     direction, so it also rides on a line drawn the other way. Ranked edges
     group first, so a merged line points the way its ordering runs. */
  interface Group { rep: ReducibleEdge; at: number; ranked: boolean; reducible: boolean }
  const groups: Group[] = [];
  const byPair = new Map<string, Group>();
  const pairOf = (from: string, to: string) => `${from}\u0000${to}`;
  const join = (e: ReducibleEdge, at: number, group: Group | undefined) => {
    if (!group) {
      const g = { rep: e, at, ranked: e.ranked, reducible: e.reducible };
      byPair.set(pairOf(e.from, e.to), g);
      groups.push(g);
      carries.set(e.key, [e.key]);
      return;
    }
    mergedInto.set(e.key, group.rep.key);
    carries.get(group.rep.key)!.push(e.key);
    group.ranked ||= e.ranked;
    /* A merged line is dropped only if EVERY edge it carries is pure ordering. */
    group.reducible &&= e.reducible;
  };
  visible.forEach((e, at) => { if (e.ranked) join(e, at, byPair.get(pairOf(e.from, e.to))); });
  visible.forEach((e, at) => {
    if (!e.ranked) join(e, at, byPair.get(pairOf(e.from, e.to)) ?? byPair.get(pairOf(e.to, e.from)));
  });
  groups.sort((a, b) => a.at - b.at);
  /* Carried keys in input order, the line's own key first. */
  const order = new Map(visible.map((e, at) => [e.key, at]));
  carries.forEach((keys, rep) => carries.set(rep, [rep, ...keys.slice(1).sort((a, b) => order.get(a)! - order.get(b)!)]));

  // ── Transitive reduction ────────────────────────────────────────────────────
  const live = new Set(groups.filter((g) => g.ranked && g.rep.from !== g.rep.to));
  const out = new Map<string, Group[]>();
  live.forEach((g) => out.set(g.rep.from, [...(out.get(g.rep.from) ?? []), g]));
  /* Reachable from `from` to `to` over live edges, not using `skip`. */
  const reaches = (from: string, to: string, skip: Group): boolean => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop()!;
      for (const g of out.get(at) ?? []) {
        if (g === skip || !live.has(g)) continue;
        if (g.rep.to === to) return true;
        if (!seen.has(g.rep.to)) {
          seen.add(g.rep.to);
          stack.push(g.rep.to);
        }
      }
    }
    return false;
  };
  groups.forEach((g) => {
    if (!g.reducible || !live.has(g)) return;
    if (reaches(g.rep.from, g.rep.to, g)) {
      live.delete(g);
      carries.get(g.rep.key)!.forEach((k) => implied.add(k));
      carries.delete(g.rep.key);
    }
  });

  const kept = groups.filter((g) => !implied.has(g.rep.key)).map((g) => g.rep.key);
  /* An implied line's merged edges are implied, not merged. */
  mergedInto.forEach((_, k) => { if (implied.has(k)) mergedInto.delete(k); });
  return { kept, mergedInto, carries, implied, folded };
}
