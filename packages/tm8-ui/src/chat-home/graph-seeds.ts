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
 * CAP (open question Q2, decided): `MAX_GRAPH_SEEDS = 64` — the session
 * graph's `MAX_CELLS`, beyond which that canvas already ruled a drawing
 * unreadable. FIRST-SEEN wins, not recency: evicting a settled node
 * mid-stream would move every card after it (violating the R9 stability
 * rule), and first-reference order is the one order that never changes under
 * streaming. The overflow is counted and captioned, never silent.
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
  /** First-reference order, capped at `MAX_GRAPH_SEEDS`. */
  seeds: readonly GraphSeed[];
  /** Distinct entities the cap kept off the canvas. */
  overflow: number;
}

export function foldGraphSeeds(
  turns: readonly ChatTurn[],
  suppressEntityIds?: ReadonlySet<string>,
): GraphSeedFold {
  const byId = new Map<string, GraphSeed>();
  const overflowIds = new Set<string>();
  for (const turn of turns) {
    for (const ref of refsOf(turn)) {
      if (suppressEntityIds?.has(ref.id)) continue;
      const existing = byId.get(ref.id);
      if (existing) {
        // Richer fields win when they finally arrive; write-ness accumulates.
        if (ref.title && !existing.title) existing.title = ref.title;
        if (ref.kind && !existing.kind) existing.kind = ref.kind;
        if (ref.mutated) existing.mutated = true;
      } else if (byId.size < MAX_GRAPH_SEEDS) {
        byId.set(ref.id, { id: ref.id, kind: ref.kind, title: ref.title, mutated: ref.mutated });
      } else {
        overflowIds.add(ref.id);
      }
    }
  }
  return { seeds: [...byId.values()], overflow: overflowIds.size };
}
