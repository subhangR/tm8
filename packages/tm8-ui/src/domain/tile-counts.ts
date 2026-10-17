import type { EntityCounters } from '@tm8/contract';

/**
 * THE TILE COUNTS LINE — what an entity has PRODUCED, as one line of
 * glyph+number under a quiet row (design doc 01a1465d §6, approved
 * 2026-10-16).
 *
 * ONE CONSTANT, FIXED ORDER. `TILE_LINK_GROUPS` is the whole vocabulary and
 * the whole order: Docs · PRs · Artifacts · Drawings · Memories. It is one
 * constant on purpose — the fifth slot (Memories) is the one Subhang may want
 * swapped for Files, and that swap must be a one-line edit here rather than a
 * hunt through two components and three tests. Nothing downstream may
 * re-order, append to, or filter this list by kind.
 *
 * HONESTY RULES, both directions of nothing (inherited from 108):
 *   · zero draws NOTHING — a count exists to say something is here;
 *   · ABSENT draws nothing either, and is a DIFFERENT fact from zero. Absence
 *     is "this server never counted": a node older than migration 329 sends
 *     no `prs`, `artifacts` or `drawings`, and one older than 108 sends no
 *     `docs` or `memories`. So every counter is read through `countOf` below,
 *     which trusts the TYPE of what it finds rather than the shape of the
 *     interface, and a row whose counts are all absent has no second line at
 *     all.
 *
 * This lives in `domain/` because the kind words are the point (§15.2: no
 * component knows a kind) — the renderer draws whatever this answers and
 * learns nothing about docs, PRs or memories.
 */
export interface TileLinkGroup {
  /** The group's identity in the row (`data-count-kind`) and in the detail panel. */
  id: string;
  /**
   * The key on `EntityCounters` this group's number is read from. A STRING,
   * not a keyof: a swapped-in group (Files) may name a counter the interface
   * does not declare yet, and this module's whole job is to survive that
   * honestly.
   */
  counter: string;
  /**
   * The registry kind whose drawn mark (KindIcon) the count wears, and the
   * kind the detail panel opens when the count is clicked. Carried as DATA so
   * no component maps a group id to a kind itself.
   */
  kind: string;
  /** Singular noun for the accessible name; the renderer pluralises. */
  label: string;
}

/**
 * THE FIVE GROUPS. Swap the fifth entry for
 * `{ id: 'files', counter: 'files', kind: 'file', label: 'file' }` and the
 * tiles, the counts line and the detail-panel door all follow.
 */
export const TILE_LINK_GROUPS: readonly TileLinkGroup[] = [
  { id: 'docs', counter: 'docs', kind: 'doc', label: 'doc' },
  { id: 'prs', counter: 'prs', kind: 'pull_request', label: 'pull request' },
  { id: 'artifacts', counter: 'artifacts', kind: 'artifact', label: 'artifact' },
  { id: 'drawings', counter: 'drawings', kind: 'drawing', label: 'drawing' },
  { id: 'memories', counter: 'memories', kind: 'memory', label: 'memory' },
];

/** One group with a number worth drawing. */
export interface TileLinkCount {
  group: TileLinkGroup;
  count: number;
}

/**
 * THE DEFENSIVE READ. `counters` is typed `EntityCounters`, but a group may
 * name a key it does not declare — so this reads the object as a bag and
 * accepts only a finite positive integer. A string, a null, a NaN or a
 * negative number from a node mid-rollout is treated as ABSENT, which draws
 * nothing, rather than as a count the reader would have to disbelieve.
 */
function countOf(counters: EntityCounters, key: string): number | null {
  const value = (counters as unknown as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n > 0 ? n : null;
}

/**
 * The groups this client knows the server does NOT count yet (no column on
 * `entity_counters`). The viewer can still choose them — the choice is kept —
 * and the settings menu says plainly that nothing will show until they are
 * counted. Empty since migration 329 counted PRs, artifacts and drawings; a
 * group swapped in ahead of its column (Files) goes here.
 */
export const UNCOUNTED_LINK_GROUPS: ReadonlySet<string> = new Set();

/**
 * The counts line's content, in `TILE_LINK_GROUPS` order, zeros and absences
 * dropped — and any group the viewer turned off (`hidden`, by group id: the
 * List settings menu's per-link switches, Subhang 2026-10-17).
 */
export function tileLinkCountsOf(counters: EntityCounters, hidden?: ReadonlySet<string>): TileLinkCount[] {
  const out: TileLinkCount[] = [];
  for (const group of TILE_LINK_GROUPS) {
    if (hidden?.has(group.id)) continue;
    const count = countOf(counters, group.counter);
    if (count !== null) out.push({ group, count });
  }
  return out;
}

/**
 * Whether the row gets a second line at all. Mounts ask this BEFORE building
 * the element, because a JSX element is truthy even when it renders null and
 * the tile's own geometry (29px vs ~43px) depends on the answer.
 */
export function hasTileLinkCounts(counters: EntityCounters, hidden?: ReadonlySet<string>): boolean {
  return TILE_LINK_GROUPS.some((group) => !hidden?.has(group.id) && countOf(counters, group.counter) !== null);
}
