/**
 * THE FLOWCHART LAYOUT — a layered (Sugiyama-style) placement with routed,
 * ported, orthogonal edges and collision-free labels. Pure and deterministic:
 * the same input places every card and every bend at the same coordinates.
 *
 * WHY HAND-ROLLED (evaluated 2026-09-24):
 * - elkjs: EPL-2.0 / GPL-3.0 (weak copyleft) and a GWT-compiled ~1.4 MB
 *   minified bundle, loaded on the one screen that needs it. Too heavy, and
 *   the licence needs a review this feature should not wait on.
 * - @dagrejs/dagre: MIT and much smaller, but it has none of the things Craft
 *   needs beyond ranking: no swimlane (partition) constraint, no side ports,
 *   no way to keep user-pinned nodes fixed, and its bend points are
 *   polylines through dummy nodes, not orthogonal routes that stay out of
 *   cards. We would wrap it in most of this file anyway.
 * The algorithm below is the textbook pipeline, sized for blueprints (tens to
 * low hundreds of nodes), in one dependency-free file.
 *
 * THE PIPELINE, in abstract coordinates (u = the flow axis, v = across it;
 * LR maps u→x, TB maps u→y):
 *   1. break cycles  — DFS in input order; back edges are reversed for
 *                      ranking and drawn as `back` edges
 *   2. rank          — longest path, then sources pulled up to their earliest
 *                      successor so an input sits next to what consumes it
 *   3. dummies       — a long edge gets a slot in every rank it crosses, so it
 *                      is routed THROUGH the gaps between cards, never under one
 *   4. order         — barycenter sweeps, lane-major, keeping the ordering
 *                      with the fewest crossings
 *   5. coordinates   — columns per rank; across-axis positions by weighted
 *                      isotonic regression (exact least squares under the
 *                      "cards may not overlap and keep their order" constraint)
 *   6. route         — ports spread along card sides; one private vertical
 *                      track per edge per gap
 *   7. labels        — greedy, on the route's own segments, avoiding every
 *                      card and every placed label; no slot ⇒ null (hover)
 * Pinned nodes (the row's stored `layout`) take part in ranking and ordering
 * so their neighbours land sensibly, then keep exactly their stored position;
 * any edge touching one is routed by the generic router.
 */

export type LayoutDirection = 'LR' | 'TB';

export interface LayoutNodeInput {
  key: string;
  width: number;
  height: number;
  /** Swimlane key; nodes of one lane form one contiguous band. */
  lane?: string | null;
  /** Top-left override. */
  pinned?: { x: number; y: number } | null;
}

export interface LayoutEdgeInput {
  key: string;
  /** DRAW direction: `from` comes first in the flow. */
  from: string;
  to: string;
  /** False ⇒ routed but does not order anything (context/relates_to). */
  ranked: boolean;
  /** Label size to place, if any. */
  label?: { width: number; height: number } | null;
}

export interface LayoutOptions {
  direction?: LayoutDirection;
  /** Lane order. Lanes named by nodes but missing here are appended in first-seen order. */
  lanes?: readonly { key: string; label: string }[] | null;
  rankGap?: number;
  nodeGap?: number;
  laneGap?: number;
  /** Space reserved at the start of each lane band for its header. */
  laneHeader?: number;
  pad?: number;
}

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }

export interface LayoutNodeResult extends Box {
  rank: number;
  order: number;
  lane: string | null;
  pinned: boolean;
}

export interface LayoutEdgeResult {
  points: Point[];
  /** Runs against the flow (it closed a cycle). */
  back: boolean;
  labelBox: Box | null;
}

export interface LayoutResult {
  nodes: Map<string, LayoutNodeResult>;
  edges: Map<string, LayoutEdgeResult>;
  lanes: { key: string; label: string; box: Box }[];
  /** Crossings between adjacent ranks in the final ordering (a quality metric for tests). */
  crossings: number;
}

const DEFAULTS = { rankGap: 120, nodeGap: 28, laneGap: 24, laneHeader: 28, pad: 24 };
const DUMMY_SIZE = 14;
const ORDER_SWEEPS = 12;
const COORD_PASSES = 8;
const CORNER = 8;

interface V {
  id: string;
  /** Index into the input nodes; -1 for dummies. */
  index: number;
  dummy: boolean;
  su: number;
  sv: number;
  lane: number;
  rank: number;
  /** Across-axis TOP (not centre). */
  v: number;
}

interface Seg { a: string; b: string; edge: string }

export function layoutGraph(
  nodesIn: readonly LayoutNodeInput[],
  edgesIn: readonly LayoutEdgeInput[],
  options: LayoutOptions = {},
): LayoutResult {
  const dir = options.direction ?? 'LR';
  const rankGap = options.rankGap ?? DEFAULTS.rankGap;
  const nodeGap = options.nodeGap ?? DEFAULTS.nodeGap;
  const pad = options.pad ?? DEFAULTS.pad;
  const lanesOn = options.lanes !== undefined && options.lanes !== null;
  const laneGap = lanesOn ? options.laneGap ?? DEFAULTS.laneGap : 0;
  const laneHeader = lanesOn ? options.laneHeader ?? DEFAULTS.laneHeader : 0;
  const LR = dir === 'LR';

  /* De-duplicate node keys: the first wins (the validator reports the rest). */
  const unique: LayoutNodeInput[] = [];
  const seenKeys = new Set<string>();
  nodesIn.forEach((n) => {
    if (seenKeys.has(n.key)) return;
    seenKeys.add(n.key);
    unique.push(n);
  });
  /* PARKED: a node with no edge at all (an orphan spec, a fresh insertion)
     takes no part in the flow. It sits in a strip after it, so adding one
     never widens a column or reorders a layer that was already drawn. With
     lanes it stays in its lane — the lane is its placement. */
  const touched = new Set(edgesIn.flatMap((e) => [e.from, e.to]));
  const parked = lanesOn ? [] : unique.filter((n) => !touched.has(n.key) && !n.pinned);
  const parkedKeys = new Set(parked.map((n) => n.key));
  const nodes = unique.filter((n) => !parkedKeys.has(n.key));
  const nodeIndex = new Map<string, number>(nodes.map((n, i) => [n.key, i]));

  /* LANES: declared order, then first-seen. Without lanes every node is lane 0. */
  const laneList: { key: string; label: string }[] = lanesOn ? [...(options.lanes ?? [])] : [];
  const laneOf = new Map(laneList.map((l, i) => [l.key, i]));
  if (lanesOn) {
    nodes.forEach((n) => {
      const key = n.lane ?? '';
      if (!laneOf.has(key)) {
        laneOf.set(key, laneList.length);
        laneList.push({ key, label: key });
      }
    });
  }

  const verts = new Map<string, V>();
  nodes.forEach((n, index) => {
    verts.set(n.key, {
      id: n.key, index, dummy: false,
      su: LR ? n.width : n.height,
      sv: LR ? n.height : n.width,
      lane: lanesOn ? laneOf.get(n.lane ?? '') ?? 0 : 0,
      rank: 0, v: 0,
    });
  });

  const edges = edgesIn.filter((e) => nodeIndex.has(e.from) && nodeIndex.has(e.to));

  // ── 1. Break cycles ──────────────────────────────────────────────────────────
  const ranked = edges.filter((e) => e.ranked && e.from !== e.to);
  const out = new Map<string, LayoutEdgeInput[]>();
  ranked.forEach((e) => out.set(e.from, [...(out.get(e.from) ?? []), e]));
  const reversed = new Set<string>();
  {
    const state = new Map<string, 1 | 2>();
    for (const root of nodes) {
      if (state.has(root.key)) continue;
      const stack: { v: string; i: number }[] = [{ v: root.key, i: 0 }];
      state.set(root.key, 1);
      while (stack.length > 0) {
        const top = stack[stack.length - 1] as { v: string; i: number };
        const list = out.get(top.v) ?? [];
        if (top.i >= list.length) {
          state.set(top.v, 2);
          stack.pop();
          continue;
        }
        const e = list[top.i] as LayoutEdgeInput;
        top.i += 1;
        const s = state.get(e.to);
        if (s === 1) reversed.add(e.key);
        else if (s === undefined) {
          state.set(e.to, 1);
          stack.push({ v: e.to, i: 0 });
        }
      }
    }
  }
  /* Oriented ranking edges: tail ranks strictly before head. */
  const oriented = ranked.map((e) => (reversed.has(e.key)
    ? { key: e.key, tail: e.to, head: e.from }
    : { key: e.key, tail: e.from, head: e.to }));

  // ── 2. Rank ──────────────────────────────────────────────────────────────────
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  oriented.forEach((e) => {
    succs.set(e.tail, [...(succs.get(e.tail) ?? []), e.head]);
    preds.set(e.head, [...(preds.get(e.head) ?? []), e.tail]);
  });
  const topo: string[] = [];
  {
    const indeg = new Map(nodes.map((n) => [n.key, (preds.get(n.key) ?? []).length]));
    /* Kahn's algorithm with an input-order queue: deterministic. */
    const ready = nodes.filter((n) => indeg.get(n.key) === 0).map((n) => n.key);
    const inReady = new Set(ready);
    while (ready.length > 0) {
      ready.sort((a, b) => (nodeIndex.get(a) as number) - (nodeIndex.get(b) as number));
      const v = ready.shift() as string;
      topo.push(v);
      for (const w of succs.get(v) ?? []) {
        const d = (indeg.get(w) as number) - 1;
        indeg.set(w, d);
        if (d === 0 && !inReady.has(w)) { ready.push(w); inReady.add(w); }
      }
    }
  }
  const rank = new Map<string, number>();
  topo.forEach((v) => {
    const ps = preds.get(v) ?? [];
    rank.set(v, ps.length === 0 ? 0 : Math.max(...ps.map((p) => (rank.get(p) as number) + 1)));
  });
  /* Tighten: a pure source sits one rank before its earliest successor, so an
     input is drawn beside the task that consumes it rather than in column 0. */
  [...topo].reverse().forEach((v) => {
    if ((preds.get(v) ?? []).length > 0) return;
    const ss = succs.get(v) ?? [];
    if (ss.length > 0) rank.set(v, Math.min(...ss.map((s) => rank.get(s) as number)) - 1);
  });
  /* Nodes with only unranked links follow their first ranked neighbour. */
  const hasRanked = new Set(oriented.flatMap((e) => [e.tail, e.head]));
  edges.filter((e) => !e.ranked).forEach((e) => {
    for (const [me, other] of [[e.from, e.to], [e.to, e.from]] as const) {
      if (!hasRanked.has(me) && hasRanked.has(other) && !rank.has(`~${me}`)) {
        rank.set(me, rank.get(other) as number);
        rank.set(`~${me}`, 1);
      }
    }
  });
  const minRank = Math.min(0, ...nodes.map((n) => rank.get(n.key) ?? 0));
  nodes.forEach((n) => { (verts.get(n.key) as V).rank = (rank.get(n.key) ?? 0) - minRank; });

  // ── 3. Dummies ───────────────────────────────────────────────────────────────
  const segs: Seg[] = [];
  const chains = new Map<string, string[]>();
  oriented.forEach((e) => {
    const t = verts.get(e.tail) as V;
    const h = verts.get(e.head) as V;
    const chain: string[] = [e.tail];
    for (let r = t.rank + 1; r < h.rank; r += 1) {
      const id = `\u0000${e.key}\u0000${r}`;
      verts.set(id, {
        id, index: -1, dummy: true, su: 0, sv: DUMMY_SIZE,
        lane: r - t.rank <= (h.rank - t.rank) / 2 ? t.lane : h.lane,
        rank: r, v: 0,
      });
      chain.push(id);
    }
    chain.push(e.head);
    chains.set(e.key, chain);
    for (let i = 0; i + 1 < chain.length; i += 1) segs.push({ a: chain[i] as string, b: chain[i + 1] as string, edge: e.key });
  });

  // ── 4. Order ─────────────────────────────────────────────────────────────────
  const maxRank = Math.max(0, ...[...verts.values()].map((v) => v.rank));
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  /* Initial order: real nodes by input order, then dummies by edge order —
     so an unrelated insertion never reorders what was already there. */
  nodes.forEach((n) => layers[(verts.get(n.key) as V).rank]?.push(n.key));
  verts.forEach((v) => { if (v.dummy) layers[v.rank]?.push(v.id); });
  layers.forEach((layer) => layer.sort((a, b) => (verts.get(a) as V).lane - (verts.get(b) as V).lane));

  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  segs.forEach((s) => {
    down.set(s.a, [...(down.get(s.a) ?? []), s.b]);
    up.set(s.b, [...(up.get(s.b) ?? []), s.a]);
  });
  const pos = new Map<string, number>();
  const index = () => layers.forEach((layer) => layer.forEach((id, i) => pos.set(id, i)));
  index();
  const countCrossings = (): number => {
    let total = 0;
    for (let r = 0; r < maxRank; r += 1) {
      const pairs: [number, number][] = [];
      (layers[r] as string[]).forEach((a) => (down.get(a) ?? []).forEach((b) => pairs.push([pos.get(a) as number, pos.get(b) as number])));
      for (let i = 0; i < pairs.length; i += 1) {
        for (let j = i + 1; j < pairs.length; j += 1) {
          const [a1, b1] = pairs[i] as [number, number];
          const [a2, b2] = pairs[j] as [number, number];
          if ((a1 - a2) * (b1 - b2) < 0) total += 1;
        }
      }
    }
    return total;
  };
  let best = layers.map((l) => [...l]);
  let bestCrossings = countCrossings();
  for (let sweep = 0; sweep < ORDER_SWEEPS && bestCrossings > 0; sweep += 1) {
    const downward = sweep % 2 === 0;
    const range = downward
      ? Array.from({ length: maxRank }, (_, i) => i + 1)
      : Array.from({ length: maxRank }, (_, i) => maxRank - 1 - i);
    for (const r of range) {
      const layer = layers[r] as string[];
      const nbrs = downward ? up : down;
      const bary = new Map<string, number>();
      layer.forEach((id) => {
        const ns = nbrs.get(id) ?? [];
        bary.set(id, ns.length === 0
          ? (pos.get(id) as number)
          : ns.reduce((sum, n) => sum + (pos.get(n) as number), 0) / ns.length);
      });
      layer.sort((a, b) => {
        const va = verts.get(a) as V;
        const vb = verts.get(b) as V;
        return va.lane - vb.lane
          || (bary.get(a) as number) - (bary.get(b) as number)
          || (pos.get(a) as number) - (pos.get(b) as number);
      });
      layer.forEach((id, i) => pos.set(id, i));
    }
    const c = countCrossings();
    if (c < bestCrossings) {
      bestCrossings = c;
      best = layers.map((l) => [...l]);
    }
  }
  best.forEach((layer, r) => { layers[r] = layer; });
  index();

  // ── 5. Coordinates ───────────────────────────────────────────────────────────
  /* u: one column per rank, as wide as its widest card. */
  const colSize = layers.map((layer) => Math.max(0, ...layer.map((id) => (verts.get(id) as V).su)));
  const colStart: number[] = [];
  colSize.forEach((size, r) => {
    colStart.push(r === 0 ? pad : (colStart[r - 1] as number) + (colSize[r - 1] as number) + rankGap);
    void size;
  });
  const uOf = (v: V) => (colStart[v.rank] as number) + ((colSize[v.rank] as number) - v.su) / 2;

  /* v: lane-local tops by weighted isotonic regression, then lane bands. */
  const laneCount = Math.max(1, laneList.length);
  const laneTop = new Array<number>(laneCount).fill(0);
  const center = (v: V) => laneTop[v.lane] as number + v.v + v.sv / 2;
  const placeLayer = (layer: string[], nbrs: Map<string, string[]> | null) => {
    for (let lane = 0; lane < laneCount; lane += 1) {
      const ids = layer.filter((id) => (verts.get(id) as V).lane === lane);
      if (ids.length === 0) continue;
      const vs = ids.map((id) => verts.get(id) as V);
      /* offset[i] = minimum top of i relative to item 0 when packed tight. */
      const offset: number[] = [0];
      for (let i = 1; i < vs.length; i += 1) {
        const prev = vs[i - 1] as V;
        const gap = prev.dummy || (vs[i] as V).dummy ? nodeGap / 2 : nodeGap;
        offset.push((offset[i - 1] as number) + prev.sv + gap);
      }
      const desired = vs.map((v) => {
        const ns = nbrs ? (nbrs.get(v.id) ?? []) : [];
        if (ns.length === 0) return v.v;
        const c = ns.reduce((sum, n) => sum + center(verts.get(n) as V), 0) / ns.length;
        return c - (laneTop[lane] as number) - v.sv / 2;
      });
      const weights = vs.map((v) => (v.dummy ? 2 : 1));
      const fitted = isotonic(desired.map((d, i) => d - (offset[i] as number)), weights);
      /* A lane's content never starts above its band. */
      const lift = Math.max(0, -Math.min(...fitted));
      vs.forEach((v, i) => { v.v = (fitted[i] as number) + lift + (offset[i] as number); });
    }
  };
  const restack = () => {
    let top = pad;
    for (let lane = 0; lane < laneCount; lane += 1) {
      /* A lane's content starts at its own band top. Without this, alignment
         with a NEIGHBOURING lane pulls a whole lane down, the next restack
         pushes the lanes below it further, and the bands drift apart with an
         empty void above their cards. */
      let minV = Infinity;
      verts.forEach((v) => { if (v.lane === lane) minV = Math.min(minV, v.v); });
      if (Number.isFinite(minV) && minV !== 0) verts.forEach((v) => { if (v.lane === lane) v.v -= minV; });
      laneTop[lane] = top + laneHeader;
      let extent = 0;
      verts.forEach((v) => { if (v.lane === lane) extent = Math.max(extent, v.v + v.sv); });
      top += laneHeader + extent + laneGap + (lanesOn ? nodeGap / 2 : 0);
    }
  };
  layers.forEach((layer) => placeLayer(layer, null));
  restack();
  for (let pass = 0; pass < COORD_PASSES; pass += 1) {
    const downward = pass % 2 === 0;
    const order = downward ? layers : [...layers].reverse();
    order.forEach((layer) => placeLayer(layer, downward ? up : down));
    restack();
  }
  /* Final pass: centre each layer against BOTH neighbours. */
  const both = new Map<string, string[]>();
  verts.forEach((v) => both.set(v.id, [...(up.get(v.id) ?? []), ...(down.get(v.id) ?? [])]));
  layers.forEach((layer) => placeLayer(layer, both));
  /* Normalise: lane 0 starts at the pad. */
  const minTop = Math.min(...[...verts.values()].filter((v) => !v.dummy || true).map((v) => v.v), Infinity);
  if (Number.isFinite(minTop) && minTop > 0 && !lanesOn) verts.forEach((v) => { v.v -= minTop; });
  restack();

  /* To final x/y. */
  const toXY = (u: number, v: number): Point => (LR ? { x: u, y: v } : { x: v, y: u });
  const result = new Map<string, LayoutNodeResult>();
  nodes.forEach((n) => {
    const v = verts.get(n.key) as V;
    const auto = toXY(uOf(v), (laneTop[v.lane] as number) + v.v);
    const pinned = n.pinned && Number.isFinite(n.pinned.x) && Number.isFinite(n.pinned.y) ? n.pinned : null;
    result.set(n.key, {
      x: pinned ? pinned.x : auto.x,
      y: pinned ? pinned.y : auto.y,
      width: n.width, height: n.height,
      rank: v.rank, order: pos.get(n.key) as number,
      lane: lanesOn ? (laneList[v.lane] as { key: string }).key : null,
      pinned: pinned !== null,
    });
  });

  /* The parked strip: after the flow (below it in LR, beside it in TB), in
     input order, wrapping at the flow's own breadth. */
  if (parked.length > 0) {
    const placedBoxes = [...result.values()].filter((b) => !b.pinned);
    const flowEnd = placedBoxes.length > 0
      ? Math.max(...placedBoxes.map((b) => (LR ? b.y + b.height : b.x + b.width))) + rankGap / 2
      : pad;
    const breadth = Math.max(
      3 * (Math.max(...parked.map((n) => (LR ? n.width : n.height))) + nodeGap),
      ...placedBoxes.map((b) => (LR ? b.x + b.width : b.y + b.height)),
    );
    let along = pad;
    let across = flowEnd;
    let rowSize = 0;
    parked.forEach((n) => {
      const a = LR ? n.width : n.height;
      const c = LR ? n.height : n.width;
      if (along > pad && along + a > breadth) {
        along = pad;
        across += rowSize + nodeGap;
        rowSize = 0;
      }
      result.set(n.key, {
        x: LR ? along : across, y: LR ? across : along,
        width: n.width, height: n.height, rank: -1, order: -1, lane: null, pinned: false,
      });
      along += a + nodeGap;
      rowSize = Math.max(rowSize, c);
    });
  }

  // ── 6. Route ─────────────────────────────────────────────────────────────────
  const cards: Box[] = [...result.values()];
  const routes = new Map<string, LayoutEdgeResult>();
  const pinnedKeys = new Set(nodes.filter((n) => result.get(n.key)?.pinned).map((n) => n.key));

  /* Ports: each card side spreads its edges, sorted by where the other end is. */
  const layered = oriented.filter((e) => !pinnedKeys.has(e.tail) && !pinnedKeys.has(e.head));
  const outPorts = new Map<string, Map<string, number>>();
  const inPorts = new Map<string, Map<string, number>>();
  const spread = (owner: string, list: { edge: string; along: number }[], into: Map<string, Map<string, number>>) => {
    const v = verts.get(owner) as V;
    const top = (laneTop[v.lane] as number) + v.v;
    list.sort((a, b) => a.along - b.along || (a.edge < b.edge ? -1 : 1));
    const m = new Map<string, number>();
    list.forEach((item, i) => m.set(item.edge, top + (v.sv * (i + 1)) / (list.length + 1)));
    into.set(owner, m);
  };
  const byTail = new Map<string, { edge: string; along: number }[]>();
  const byHead = new Map<string, { edge: string; along: number }[]>();
  layered.forEach((e) => {
    const chain = chains.get(e.key) as string[];
    const next = verts.get(chain[1] as string) as V;
    const prev = verts.get(chain[chain.length - 2] as string) as V;
    byTail.set(e.tail, [...(byTail.get(e.tail) ?? []), { edge: e.key, along: center(next) }]);
    byHead.set(e.head, [...(byHead.get(e.head) ?? []), { edge: e.key, along: center(prev) }]);
  });
  byTail.forEach((list, owner) => spread(owner, list, outPorts));
  byHead.forEach((list, owner) => spread(owner, list, inPorts));

  /* Abstract polylines first (so tracks can be assigned per gap), then tracks. */
  interface Jog { edge: string; gap: number; va: number; vb: number }
  const jogs: Jog[] = [];
  const abstract = new Map<string, { u: number; v: number | null; gap?: number }[]>();
  layered.forEach((e) => {
    const chain = chains.get(e.key) as string[];
    const t = verts.get(e.tail) as V;
    const h = verts.get(e.head) as V;
    const pts: { u: number; v: number | null; gap?: number }[] = [];
    const vOut = outPorts.get(e.tail)?.get(e.key) as number;
    const vIn = inPorts.get(e.head)?.get(e.key) as number;
    pts.push({ u: uOf(t) + t.su, v: vOut });
    let vCur = vOut;
    for (let i = 1; i < chain.length; i += 1) {
      const node = verts.get(chain[i] as string) as V;
      const gap = node.rank - 1;
      const target = i === chain.length - 1 ? vIn : center(node);
      /* A sub-pixel jog is noise from the placement; stay straight. */
      const vNext = Math.abs(target - vCur) <= 0.5 ? vCur : target;
      pts.push({ u: (colStart[gap] as number) + (colSize[gap] as number), v: vCur });
      if (Math.abs(vNext - vCur) > 0.5) {
        jogs.push({ edge: e.key, gap, va: vCur, vb: vNext });
        pts.push({ u: NaN, v: vCur, gap }, { u: NaN, v: vNext, gap });
      }
      pts.push({ u: colStart[node.rank] as number, v: vNext });
      if (i < chain.length - 1) pts.push({ u: (colStart[node.rank] as number) + (colSize[node.rank] as number), v: vNext });
      vCur = vNext;
    }
    pts.push({ u: uOf(h), v: vCur });
    abstract.set(e.key, pts);
  });
  /* One private track per jog per gap. Downward jogs take tracks left→right
     in top order, upward ones right→left: nested jogs then never cross. */
  const track = new Map<string, number>();
  const gaps = new Map<number, Jog[]>();
  jogs.forEach((j) => gaps.set(j.gap, [...(gaps.get(j.gap) ?? []), j]));
  gaps.forEach((list, gap) => {
    const start = (colStart[gap] as number) + (colSize[gap] as number);
    const width = rankGap;
    const downs = list.filter((j) => j.vb > j.va).sort((a, b) => b.va - a.va || a.vb - b.vb);
    const ups = list.filter((j) => j.vb < j.va).sort((a, b) => a.va - b.va || b.vb - a.vb);
    const ordered = [...downs, ...ups];
    ordered.forEach((j, i) => track.set(`${j.edge}\u0000${gap}`, start + (width * (i + 1)) / (ordered.length + 1)));
  });
  layered.forEach((e) => {
    const pts = (abstract.get(e.key) as { u: number; v: number | null; gap?: number }[])
      .map((p) => (Number.isNaN(p.u) ? { u: track.get(`${e.key}\u0000${p.gap}`) as number, v: p.v as number } : { u: p.u, v: p.v as number }))
      .map((p) => toXY(p.u, p.v));
    const isBack = reversed.has(e.key);
    routes.set(e.key, { points: simplify(isBack ? pts.reverse() : pts), back: isBack, labelBox: null });
  });

  /* Everything else — unranked links, same-rank links, pinned endpoints,
     self-loops — goes through the generic router. */
  edges.forEach((e) => {
    if (routes.has(e.key)) return;
    const a = result.get(e.from) as LayoutNodeResult;
    const b = result.get(e.to) as LayoutNodeResult;
    routes.set(e.key, { points: e.from === e.to ? selfLoop(a, LR) : genericRoute(a, b, cards, LR, rankGap), back: reversed.has(e.key), labelBox: null });
  });

  // ── 7. Labels ────────────────────────────────────────────────────────────────
  const taken: Box[] = cards.map((c) => inflate(c, 2));
  edges.forEach((e) => {
    const route = routes.get(e.key) as LayoutEdgeResult;
    if (!e.label) return;
    route.labelBox = placeLabel(route.points, e.label, taken);
    if (route.labelBox) taken.push(inflate(route.labelBox, 2));
  });

  const laneBoxes = lanesOn
    ? laneList.map((lane, i) => {
      const top = (laneTop[i] as number) - laneHeader;
      let extent = 0;
      verts.forEach((v) => { if (v.lane === i) extent = Math.max(extent, v.v + v.sv); });
      const across = laneHeader + extent + nodeGap / 2;
      const along = (colStart[maxRank] as number) + (colSize[maxRank] as number) + pad;
      const box = LR
        ? { x: 0, y: top - nodeGap / 4, width: along, height: across }
        : { x: top - nodeGap / 4, y: 0, width: across, height: along };
      return { key: lane.key, label: lane.label, box };
    })
    : [];

  return { nodes: result, edges: routes, lanes: laneBoxes, crossings: bestCrossings };
}

/**
 * Weighted isotonic regression (pool adjacent violators): the non-decreasing
 * sequence closest to `y` in weighted least squares. With `y` shifted by each
 * item's packed offset, "non-decreasing" is exactly "no overlap, order kept".
 */
export function isotonic(y: readonly number[], w: readonly number[]): number[] {
  const blocks: { sum: number; weight: number; count: number }[] = [];
  y.forEach((value, i) => {
    const weight = w[i] ?? 1;
    blocks.push({ sum: value * weight, weight, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1] as { sum: number; weight: number; count: number };
      const prev = blocks[blocks.length - 2] as { sum: number; weight: number; count: number };
      if (prev.sum / prev.weight <= last.sum / last.weight) break;
      blocks.pop();
      prev.sum += last.sum; prev.weight += last.weight; prev.count += last.count;
    }
  });
  return blocks.flatMap((b) => new Array<number>(b.count).fill(b.sum / b.weight));
}

function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  points.forEach((p) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) return;
    const prev = out[out.length - 2];
    if (last && prev) {
      const collinear = (Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01)
        || (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01);
      if (collinear) out.pop();
    }
    out.push(p);
  });
  return out;
}

function inflate(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Does the axis-aligned segment p→q pass through the INTERIOR of box b? */
export function segmentHitsBox(p: Point, q: Point, b: Box): boolean {
  const e = 0.5;
  const minX = Math.min(p.x, q.x);
  const maxX = Math.max(p.x, q.x);
  const minY = Math.min(p.y, q.y);
  const maxY = Math.max(p.y, q.y);
  return maxX > b.x + e && minX < b.x + b.width - e && maxY > b.y + e && minY < b.y + b.height - e;
}

function routeClear(points: Point[], cards: Box[], ends: Box[]): boolean {
  for (let i = 0; i + 1 < points.length; i += 1) {
    for (const card of cards) {
      if (ends.includes(card)) continue;
      if (segmentHitsBox(points[i] as Point, points[i + 1] as Point, card)) return false;
    }
  }
  return true;
}

function selfLoop(a: Box, LR: boolean): Point[] {
  const r = 18;
  if (LR) {
    const x = a.x + a.width;
    return [{ x, y: a.y + a.height * 0.3 }, { x: x + r, y: a.y + a.height * 0.3 }, { x: x + r, y: a.y + a.height * 0.7 }, { x, y: a.y + a.height * 0.7 }];
  }
  const y = a.y + a.height;
  return [{ x: a.x + a.width * 0.3, y }, { x: a.x + a.width * 0.3, y: y + r }, { x: a.x + a.width * 0.7, y: y + r }, { x: a.x + a.width * 0.7, y }];
}

/**
 * The router for edges the layered pass does not own. Tries the natural
 * elbows first, then detours around both cards; the first candidate clear of
 * every other card wins, the first candidate is the fallback.
 */
function genericRoute(a: Box, b: Box, cards: Box[], LR: boolean, gap: number): Point[] {
  const ends = cards.filter((c) => (c.x === a.x && c.y === a.y && c.width === a.width) || (c.x === b.x && c.y === b.y && c.width === b.width));
  const acx = a.x + a.width / 2;
  const acy = a.y + a.height / 2;
  const bcx = b.x + b.width / 2;
  const bcy = b.y + b.height / 2;
  const candidates: Point[][] = [];
  const right = b.x >= a.x + a.width;
  const left = b.x + b.width <= a.x;
  const below = b.y >= a.y + a.height;
  const above = b.y + b.height <= a.y;
  if (right || left) {
    const x1 = right ? a.x + a.width : a.x;
    const x2 = right ? b.x : b.x + b.width;
    const mx = (x1 + x2) / 2;
    candidates.push([{ x: x1, y: acy }, { x: mx, y: acy }, { x: mx, y: bcy }, { x: x2, y: bcy }]);
  }
  if (below || above) {
    const y1 = below ? a.y + a.height : a.y;
    const y2 = below ? b.y : b.y + b.height;
    const my = (y1 + y2) / 2;
    candidates.push([{ x: acx, y: y1 }, { x: acx, y: my }, { x: bcx, y: my }, { x: bcx, y: y2 }]);
  }
  /* Detours: out the flow-side of both, around the far edge of the pair. */
  const detour = gap / 3;
  if (LR) {
    const far = Math.max(a.x + a.width, b.x + b.width) + detour;
    candidates.push([{ x: a.x + a.width, y: acy }, { x: far, y: acy }, { x: far, y: bcy }, { x: b.x + b.width, y: bcy }]);
    const near = Math.min(a.x, b.x) - detour;
    candidates.push([{ x: a.x, y: acy }, { x: near, y: acy }, { x: near, y: bcy }, { x: b.x, y: bcy }]);
  } else {
    const far = Math.max(a.y + a.height, b.y + b.height) + detour;
    candidates.push([{ x: acx, y: a.y + a.height }, { x: acx, y: far }, { x: bcx, y: far }, { x: bcx, y: b.y + b.height }]);
    const near = Math.min(a.y, b.y) - detour;
    candidates.push([{ x: acx, y: a.y }, { x: acx, y: near }, { x: bcx, y: near }, { x: bcx, y: b.y }]);
  }
  const clear = candidates.find((c) => routeClear(c, cards, ends));
  return simplify(clear ?? searchRoute(a, b, cards) ?? (candidates[0] as Point[]));
}

/**
 * THE FALLBACK: shortest orthogonal path on a sparse visibility grid (every
 * card edge ± a margin, plus a ring around the whole drawing so going around
 * is always possible), Dijkstra with a bend penalty. Only reached when every
 * simple elbow is blocked, so its cost is paid by the few edges that need it.
 */
function searchRoute(a: Box, b: Box, cards: Box[]): Point[] | null {
  const m = 12;
  const BEND = 40;
  const others = cards.filter((c) => c !== a && c !== b && !(c.x === a.x && c.y === a.y) && !(c.x === b.x && c.y === b.y));
  const blocked = (p: Point, q: Point) => [...others, a, b].some((c) => segmentHitsBox(p, q, c));
  const stubs = (box: Box): { side: Point; stub: Point }[] => [
    { side: { x: box.x + box.width, y: box.y + box.height / 2 }, stub: { x: box.x + box.width + m, y: box.y + box.height / 2 } },
    { side: { x: box.x, y: box.y + box.height / 2 }, stub: { x: box.x - m, y: box.y + box.height / 2 } },
    { side: { x: box.x + box.width / 2, y: box.y + box.height }, stub: { x: box.x + box.width / 2, y: box.y + box.height + m } },
    { side: { x: box.x + box.width / 2, y: box.y }, stub: { x: box.x + box.width / 2, y: box.y - m } },
  ];
  const starts = stubs(a);
  const goals = stubs(b);
  const all = [...others, a, b];
  const minX = Math.min(...all.map((c) => c.x)) - 2 * m;
  const maxX = Math.max(...all.map((c) => c.x + c.width)) + 2 * m;
  const minY = Math.min(...all.map((c) => c.y)) - 2 * m;
  const maxY = Math.max(...all.map((c) => c.y + c.height)) + 2 * m;
  const uniq = (v: number[]) => [...new Set(v.map((n) => Math.round(n * 10) / 10))].sort((p, q) => p - q);
  const xs = uniq([minX, maxX, ...all.flatMap((c) => [c.x - m, c.x + c.width + m]), ...starts.map((s) => s.stub.x), ...goals.map((g) => g.stub.x)]);
  const ys = uniq([minY, maxY, ...all.flatMap((c) => [c.y - m, c.y + c.height + m]), ...starts.map((s) => s.stub.y), ...goals.map((g) => g.stub.y)]);
  const inside = (p: Point) => all.some((c) => p.x > c.x + 0.5 && p.x < c.x + c.width - 0.5 && p.y > c.y + 0.5 && p.y < c.y + c.height - 0.5);
  const id = (i: number, j: number) => i * ys.length + j;
  const xi = new Map(xs.map((x, i) => [x, i]));
  const yi = new Map(ys.map((y, j) => [y, j]));
  const r = (n: number) => Math.round(n * 10) / 10;
  /* state = point id * 4 + incoming direction (0 →, 1 ←, 2 ↓, 3 ↑). */
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap: [number, number][] = [];
  const push = (d: number, st: number) => {
    heap.push([d, st]);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((heap[parent] as [number, number])[0] <= d) break;
      [heap[parent], heap[i]] = [heap[i] as [number, number], heap[parent] as [number, number]];
      i = parent;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0] as [number, number];
    const last = heap.pop() as [number, number];
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let s = i;
        if (l < heap.length && (heap[l] as [number, number])[0] < (heap[s] as [number, number])[0]) s = l;
        if (rr < heap.length && (heap[rr] as [number, number])[0] < (heap[s] as [number, number])[0]) s = rr;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i] as [number, number], heap[s] as [number, number]];
        i = s;
      }
    }
    return top;
  };
  const startDir = [0, 1, 2, 3];
  starts.forEach((s, k) => {
    const i = xi.get(r(s.stub.x));
    const j = yi.get(r(s.stub.y));
    if (i === undefined || j === undefined || inside(s.stub)) return;
    const st = id(i, j) * 4 + (startDir[k] as number);
    dist.set(st, 0);
    push(0, st);
  });
  const goalAt = new Map<number, number>();
  goals.forEach((g, k) => {
    const i = xi.get(r(g.stub.x));
    const j = yi.get(r(g.stub.y));
    if (i !== undefined && j !== undefined && !inside(g.stub)) goalAt.set(id(i, j), k);
  });
  let found: number | null = null;
  while (heap.length > 0) {
    const [d, st] = pop();
    if (d > (dist.get(st) ?? Infinity)) continue;
    const pid = st >> 2;
    const dir = st & 3;
    if (goalAt.has(pid)) { found = st; break; }
    const i = Math.floor(pid / ys.length);
    const j = pid % ys.length;
    const here = { x: xs[i] as number, y: ys[j] as number };
    const steps: [number, number, number][] = [[i + 1, j, 0], [i - 1, j, 1], [i, j + 1, 2], [i, j - 1, 3]];
    for (const [ni, nj, nd] of steps) {
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length) continue;
      const there = { x: xs[ni] as number, y: ys[nj] as number };
      if (inside(there) || blocked(here, there)) continue;
      const cost = d + Math.abs(there.x - here.x) + Math.abs(there.y - here.y) + (nd === dir ? 0 : BEND);
      const ns = id(ni, nj) * 4 + nd;
      if (cost < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, cost);
        prev.set(ns, st);
        push(cost, ns);
      }
    }
  }
  if (found === null) return null;
  const path: Point[] = [];
  let cur: number | undefined = found;
  while (cur !== undefined) {
    const pid = cur >> 2;
    path.push({ x: xs[Math.floor(pid / ys.length)] as number, y: ys[pid % ys.length] as number });
    cur = prev.get(cur);
  }
  path.reverse();
  const first = path[0] as Point;
  const last = path[path.length - 1] as Point;
  const start = starts.find((s) => r(s.stub.x) === first.x && r(s.stub.y) === first.y) as { side: Point; stub: Point };
  const goal = goals[goalAt.get(xi.get(last.x)! * ys.length + yi.get(last.y)!) as number] as { side: Point; stub: Point };
  /* The side point shares its stub's (grid-rounded) coordinate, so the stub stays straight. */
  const onAxis = (end: { side: Point; stub: Point }, at: Point): Point => (end.side.x !== end.stub.x
    ? { x: end.side.x, y: at.y } : { x: at.x, y: end.side.y });
  return [onAxis(start, first), ...path, onAxis(goal, last)];
}

/**
 * Greedy label placement: try the middle of each segment (longest first),
 * then its thirds; the first box clear of every card and every placed label
 * wins. Null means no clear slot — the UI shows the label on hover instead of
 * stacking it on top of something.
 */
function placeLabel(points: Point[], size: { width: number; height: number }, taken: Box[]): Box | null {
  const segments: { p: Point; q: Point; len: number; i: number }[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const p = points[i] as Point;
    const q = points[i + 1] as Point;
    segments.push({ p, q, len: Math.abs(p.x - q.x) + Math.abs(p.y - q.y), i });
  }
  segments.sort((a, b) => b.len - a.len || a.i - b.i);
  for (const t of [0.5, 0.33, 0.67]) {
    for (const s of segments) {
      const cx = s.p.x + (s.q.x - s.p.x) * t;
      const cy = s.p.y + (s.q.y - s.p.y) * t;
      const box = { x: cx - size.width / 2, y: cy - size.height / 2, width: size.width, height: size.height };
      if (!taken.some((b) => overlaps(b, box))) return box;
    }
  }
  return null;
}

/** An SVG path through orthogonal points with rounded corners. */
export function roundedPath(points: readonly Point[], radius = CORNER): string {
  if (points.length === 0) return '';
  const f = (n: number) => Math.round(n * 10) / 10;
  const first = points[0] as Point;
  let d = `M ${f(first.x)} ${f(first.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i] as Point;
    const next = points[i + 1];
    if (!next) {
      d += ` L ${f(p.x)} ${f(p.y)}`;
      break;
    }
    const prev = points[i - 1] as Point;
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const ax = p.x - ((p.x - prev.x) / (inLen || 1)) * r;
    const ay = p.y - ((p.y - prev.y) / (inLen || 1)) * r;
    const bx = p.x + ((next.x - p.x) / (outLen || 1)) * r;
    const by = p.y + ((next.y - p.y) / (outLen || 1)) * r;
    d += ` L ${f(ax)} ${f(ay)} Q ${f(p.x)} ${f(p.y)} ${f(bx)} ${f(by)}`;
  }
  return d;
}
