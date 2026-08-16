/**
 * GRAPH SEEDS — "what this conversation is about", folded from the thread's
 * tool calls. The conversation is the SELECTOR, not a node (R1): this fold
 * produces the node set and nothing else.
 *
 * THE NODE SET IS THE EXISTING CLIENT FOLD (R2): the same `projectTurnParts`
 * projection and the same `extractEntityRefs` walk the transcript chips use,
 * so the graph can never seed an entity the chips do not show. Neither of
 * those modules changes.
 *
 * INCREMENTAL BY TURN (R14): `mergeChatTurnFrame` replaces ONLY the turn a
 * frame touches — every other turn keeps referential identity — so a WeakMap
 * keyed on the turn object re-walks exactly the turns that changed. The merge
 * across turns is plain array work over ≤ a few hundred small records.
 * Suppression is applied AT MERGE, not at extraction, because the own-message
 * id set grows as the thread does and must not invalidate settled turns.
 *
 * WRITE-NESS (R6 interim source): a seed is `mutated` when a WRITE-shaped
 * tool call referenced it. Classification is conservative — only a verb that
 * names a mutation counts, and an unrecognised verb (e.g. `Bash`) counts as a
 * read, because a false "edited here" is a lie while a false "read" is only
 * an understatement. Tool names are used here for classification ONLY; none
 * ever reaches the surface (R8).
 *
 * CAP (Q2, amended 2026-08-16): the cap is a DRAW cap, not a fold cap. The
 * fold keeps every seed it saw — folding is pure array work and the 64 never
 * protected it — and splits the result at `limit` into `drawn` (first-seen,
 * default `MAX_GRAPH_SEEDS = 64`, the session graph's `MAX_CELLS`) and the
 * undrawn overflow. FIRST-SEEN wins, not recency: evicting a settled node
 * mid-stream would move every card after it (violating the R9 stability
 * rule), and first-reference order is the one order that never changes under
 * streaming. Discarding the overflow instead of returning it made every
 * count computed over the fold a lie at scale — a kind facet over a
 * truncated set reports 18 tasks when the thread referenced 30 — so the
 * overflow now carries its seeds and a per-kind breakdown, never silence.
 */
import { extractEntityRefs } from './entity-refs';
import type { GraphSeed } from './induced-graph';
import { projectTurnParts } from './turn-model';
import type { ChatTurn } from './types';

export const MAX_GRAPH_SEEDS = 64;

/**
 * Verbs that name a mutation, matched against the tool name with any MCP
 * server prefix stripped (`mcp__tm8__tm8_update_entity` and
 * `tm8_update_entity` classify identically).
 */
const WRITE_VERB =
  /(create|update|delete|remove|patch|send|post|complete|assign|unlink|link|move|write|edit|spawn|terminate|attach|upload|cancel|start|stop|rename|archive|restore|grant|revoke|dispatch|launch|set_|_set\b)/i;

function isWriteTool(name: string): boolean {
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return WRITE_VERB.test(bare);
}

interface RawSeedRef {
  id: string;
  kind?: string | undefined;
  title?: string | undefined;
  mutated: boolean;
}

/** Per-turn extraction cache. A streamed delta mints a NEW turn object for
 *  the affected turn only, so identity is exactly the right key. */
const perTurn = new WeakMap<ChatTurn, readonly RawSeedRef[]>();

function refsOf(turn: ChatTurn): readonly RawSeedRef[] {
  const cached = perTurn.get(turn);
  if (cached) return cached;
  const refs: RawSeedRef[] = [];
  for (const part of projectTurnParts(turn.parts)) {
    if (part.kind !== 'tool') continue;
    const mutated = isWriteTool(part.name);
    for (const ref of extractEntityRefs(part.args, part.result)) {
      refs.push({ id: ref.id, kind: ref.kind, title: ref.title, mutated });
    }
  }
  perTurn.set(turn, refs);
  return refs;
}

export interface GraphSeedFold {
  /** EVERY distinct entity the thread referenced, first-reference order —
   *  nothing discarded. Facet counts are computed over THIS. */
  seeds: readonly GraphSeed[];
  /** The first `limit` seeds — the set the canvas draws and the only set
   *  whose connections are ever read. */
  drawn: readonly GraphSeed[];
  /** `seeds.length - drawn.length` — entities the draw cap keeps off canvas. */
  overflow: number;
  /** The undrawn seeds broken down by kind (`'entity'` when unknown), so a
   *  facet can say `task 30 (12 not drawn)` instead of lying. */
  overflowByKind: ReadonlyMap<string, number>;
}

export function foldGraphSeeds(
  turns: readonly ChatTurn[],
  suppressEntityIds?: ReadonlySet<string>,
  opts?: { limit?: number },
): GraphSeedFold {
  const limit = opts?.limit ?? MAX_GRAPH_SEEDS;
  const byId = new Map<string, GraphSeed>();
  for (const turn of turns) {
    for (const ref of refsOf(turn)) {
      if (suppressEntityIds?.has(ref.id)) continue;
      const existing = byId.get(ref.id);
      if (existing) {
        // Richer fields win when they finally arrive; write-ness accumulates.
        if (ref.title && !existing.title) existing.title = ref.title;
        if (ref.kind && !existing.kind) existing.kind = ref.kind;
        if (ref.mutated) existing.mutated = true;
      } else {
        byId.set(ref.id, { id: ref.id, kind: ref.kind, title: ref.title, mutated: ref.mutated });
      }
    }
  }
  const seeds = [...byId.values()];
  const drawn = seeds.slice(0, limit);
  const overflowByKind = new Map<string, number>();
  for (const seed of seeds.slice(limit)) {
    const kind = seed.kind ?? 'entity';
    overflowByKind.set(kind, (overflowByKind.get(kind) ?? 0) + 1);
  }
  return { seeds, drawn, overflow: seeds.length - drawn.length, overflowByKind };
}
