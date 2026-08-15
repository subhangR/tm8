/**
 * TURN GRAPH — a pure fold of a chat thread's tool calls into the live-graph
 * star model.
 *
 * ENTIRELY CLIENT-SIDE, BY CONSTRUCTION. The transcript already extracts
 * entity references out of every tool call's args/result to draw chips
 * (`extractEntityRefs` in TurnParts). This fold reads the SAME turns and the
 * SAME extraction, so the graph can never claim a touch the chips do not
 * show, and it updates exactly as the stream does — no server, no feed, no
 * activity rows.
 *
 * SHAPE: the conversation at the centre; one node per DISTINCT entity any
 * tool call referenced; the edge label accumulates tool names ("tm8_update
 * ×3"). Repeat references never add nodes, and placement order is FIRST
 * reference so settled nodes never move while the agent streams.
 */
import type { EntityId } from '@tm8/contract';
import type { LiveGraphModel } from '../channel-screen/live-graph-model';
import { extractEntityRefs, truncateEntityId } from './entity-refs';
import { projectTurnParts } from './turn-model';
import type { ChatTurn } from './types';

export function foldTurnGraph(
  turns: readonly ChatTurn[],
  suppressEntityIds?: ReadonlySet<string>,
): LiveGraphModel {
  // Insertion order IS first-reference order — turns arrive chronologically
  // and parts are walked by seq, so no sort is needed (and a sort keyed on
  // the turn timestamp would shuffle same-turn references arbitrarily).
  const byId = new Map<string, {
    id: EntityId; kind: string; title: string;
    verbs: Record<string, number>; count: number; lastAt: string; firstAt: string;
  }>();
  let activityCount = 0;

  for (const turn of turns) {
    for (const part of projectTurnParts(turn.parts)) {
      if (part.kind !== 'tool') continue;
      const verb = toolVerb(part.name);
      for (const ref of extractEntityRefs(part.args, part.result)) {
        if (suppressEntityIds?.has(ref.id)) continue;
        activityCount += 1;
        const existing = byId.get(ref.id);
        if (existing) {
          existing.verbs[verb] = (existing.verbs[verb] ?? 0) + 1;
          existing.count += 1;
          existing.lastAt = turn.createdAt;
          // Richer fields win whenever they finally arrive — a bare-id chip
          // upgraded by a later result upgrades the node too.
          if (ref.title) existing.title = ref.title;
          if (ref.kind) existing.kind = ref.kind;
        } else {
          byId.set(ref.id, {
            id: ref.id as EntityId,
            kind: ref.kind ?? 'entity',
            title: ref.title ?? truncateEntityId(ref.id),
            verbs: { [verb]: 1 },
            count: 1,
            lastAt: turn.createdAt,
            firstAt: turn.createdAt,
          });
        }
      }
    }
  }

  return { touches: [...byId.values()], activityCount };
}

/** The edge's word is the tool's own name, shorn of MCP server prefixes —
 *  `mcp__tm8__tm8_update_entity` and `tm8_update_entity` label identically. */
export function toolVerb(name: string): string {
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return bare || name;
}
