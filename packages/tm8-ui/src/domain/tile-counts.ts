import type { EntityCounters } from '@tm8/contract';

/**
 * TILE COUNT BADGES — the registry data behind the glyph+count badges a tile
 * shows for what an entity PRODUCED or HAS LINKED. This lives in `domain/`
 * because the kind words are the point (§15.2: no component knows a kind) —
 * the component renders whatever this answers and learns nothing about kinds.
 *
 * 327 (owner ruling, chat 77ae261d, 2026-10-16): five counts, always in this
 * order — Docs · PRs · Artifacts · Drawings · Memories — from the server's
 * `counters.linked`. Message tallies left the tile entirely.
 *
 * HONESTY RULES, both directions of nothing:
 *   · zero produces NO badge — a count badge exists to say something is here;
 *   · ABSENT (`linked` missing from a pre-327 server's counters) falls back to
 *     108's attached docs / held memories, and absent THOSE produce nothing —
 *     absence is "never counted", not zero.
 */
export interface TileCountBadge {
  /** The badge's identity in the row (`data-count-kind`), a registry kind. */
  kind: string;
  /** The registry kind whose drawn mark (KindIcon) the badge wears. */
  icon: string;
  /**
   * THE EDGE RELATION THE COUNT IS DERIVED FROM, when it is exactly one —
   * 108's fallback pair: `docs` counts inbound `attached_to` from docs;
   * `memories` counts outbound `remembers` to memories. The badge's inline
   * relation group filters by EXACTLY this, so the number on the chip and the
   * rows under it are one claim (PR #272 review, blocking 1).
   */
  relation?: { type: string; direction: 'incoming' | 'outgoing' };
  /**
   * 327: the number is the SERVER's, over several edge types and (on a task)
   * its sessions' outputs, so the host must not replace it with a count of the
   * row's own hydrated edges — that read sees only direct links.
   */
  serverCounted?: true;
  count: number;
  /** Singular noun for the title; the renderer pluralises. */
  label: string;
  /**
   * The viewer's row-view switch that hides this badge (`panels/list/row-view.ts`).
   * Data here so the view never maps a badge id to a kind itself.
   */
  facet: TileCountFacet;
}

export type TileCountFacet = 'outputs' | 'prs';

const LINKED_ORDER = [
  { key: 'docs', kind: 'doc', label: 'doc', facet: 'outputs' },
  { key: 'pullRequests', kind: 'pull_request', label: 'pull request', facet: 'prs' },
  { key: 'artifacts', kind: 'artifact', label: 'artifact', facet: 'outputs' },
  { key: 'drawings', kind: 'drawing', label: 'drawing', facet: 'outputs' },
  { key: 'memories', kind: 'memory', label: 'memory', facet: 'outputs' },
] as const;

export function tileCountBadgesOf(counters: EntityCounters): TileCountBadge[] {
  const linked = counters.linked;
  if (linked) {
    return LINKED_ORDER
      .filter((spec) => linked[spec.key] > 0)
      .map((spec) => ({
        kind: spec.kind,
        icon: spec.kind,
        serverCounted: true as const,
        count: linked[spec.key],
        label: spec.label,
        facet: spec.facet,
      }));
  }
  // Rolling compatibility: a pre-327 server counted only these two.
  const badges: TileCountBadge[] = [];
  if (typeof counters.docs === 'number' && counters.docs > 0) {
    badges.push({
      kind: 'doc',
      icon: 'doc',
      relation: { type: 'attached_to', direction: 'incoming' },
      count: counters.docs,
      label: 'doc',
      facet: 'outputs',
    });
  }
  if (typeof counters.memories === 'number' && counters.memories > 0) {
    badges.push({
      kind: 'memory',
      icon: 'memory',
      relation: { type: 'remembers', direction: 'outgoing' },
      count: counters.memories,
      label: 'memory',
      facet: 'outputs',
    });
  }
  return badges;
}
