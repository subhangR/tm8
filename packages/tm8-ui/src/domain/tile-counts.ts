import type { EntityCounters } from '@tm8/contract';

/**
 * TILE COUNT BADGES (108) — the registry data behind the glyph+count badges
 * a tile shows for what an entity CARRIES: docs, memories, messages. This
 * lives in `domain/` because the kind words are the point (§15.2: no
 * component knows a kind) — the component renders whatever this answers and
 * learns nothing about kinds.
 *
 * HONESTY RULES, both directions of nothing:
 *   · zero produces NO row — a count badge exists to say something is here;
 *   · ABSENT (`docs`/`memories` missing from a pre-108 server's counters)
 *     also produces no row — absence is "never counted", not zero.
 */
export interface TileCountBadge {
  /** The badge's identity in the row (`data-count-kind`); the split message
      tallies keep their own ids here, distinct from any registry kind. */
  kind: string;
  /**
   * The registry kind whose drawn mark (KindIcon) the badge wears. Carried
   * as DATA so the component never maps a badge id to a kind itself —
   * `human-message` → the message mark is a §15.2 fact and it lives here.
   */
  icon: string;
  count: number;
  /** Singular noun for the title; the renderer pluralises. */
  label: string;
  /** Human messages receive the visual attention treatment requested by 112. */
  emphasis?: 'human';
}

export function tileCountBadgesOf(counters: EntityCounters): TileCountBadge[] {
  const badges: TileCountBadge[] = [];
  if (typeof counters.docs === 'number' && counters.docs > 0) {
    badges.push({ kind: 'doc', icon: 'doc', count: counters.docs, label: 'doc' });
  }
  if (typeof counters.memories === 'number' && counters.memories > 0) {
    badges.push({ kind: 'memory', icon: 'memory', count: counters.memories, label: 'memory' });
  }
  if (typeof counters.humanMessages === 'number' && counters.humanMessages > 0) {
    badges.push({ kind: 'human-message', icon: 'message', count: counters.humanMessages, label: 'human message', emphasis: 'human' });
  }
  if (typeof counters.agentMessages === 'number' && counters.agentMessages > 0) {
    badges.push({ kind: 'agent-message', icon: 'message', count: counters.agentMessages, label: 'agent message' });
  }
  // Rolling compatibility: an older server cannot truthfully split the total.
  // Preserve its existing neutral badge until its projection includes 109.
  if (counters.humanMessages === undefined && counters.agentMessages === undefined && counters.messages > 0) {
    badges.push({ kind: 'message', icon: 'message', count: counters.messages, label: 'message' });
  }
  return badges;
}
