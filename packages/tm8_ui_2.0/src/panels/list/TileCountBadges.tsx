import type { EntityBadges, EntityCounters } from '@tm8/contract';
import { KindIcon, tileCountBadgesOf } from '../../domain';
import { VectorIcon } from '../../kit';

/**
 * THE PERSON MARK — a filled head-and-shoulders silhouette, the familiar
 * Octicons `person` glyph shape (MIT) authored directly on this kit's own
 * 16×16 grid rather than rescaled, since Octicons already ships at 16×16.
 * The human-message badge used to draw a face-avatar stack (up to three
 * portraits) beside its count; a tile row is not the place to recognize
 * WHO posted, only that a human did and how many times, so one quiet glyph
 * replaces the stack the same way `WORKTREE_MARK` replaced a word in
 * `git/SessionLane.tsx` — same house rule, same reasoning.
 */
const PERSON_MARK = [
  'M10.3 5a2.3 2.3 0 1 1 -4.6 0 2.3 2.3 0 1 1 4.6 0Z',
  'M2 14A6 5.5 0 0 1 14 14Z',
];

/**
 * TILE COUNT BADGES (108): glyph+count for what an entity carries — docs,
 * memories, messages — beside the PR chips in a tile's badge sub-row. One
 * vocabulary for task AND session tiles.
 *
 * WHICH counts, and both honesty rules (zero renders nothing; a pre-108
 * server's ABSENT counts also render nothing), live in
 * `domain/tile-counts.ts` — §15.2: this component renders rows and knows no
 * kind. The glyphs are the registry's own marks (KindIcon), so the badge
 * and the entity list agree about what a doc looks like.
 *
 * SINCE THE RELATIONAL PANEL (user ruling 2026-08-16) a badge can also be a
 * DOOR: when the host supplies `onToggleKind` and its `expandableKind`
 * predicate admits the badge's kind, the badge renders as a button that
 * opens that kind's relation group under the tile. Which kinds expand is the
 * HOST's judgment from registry data (a real collection kind expands; the
 * message tallies stay counts) — this component keeps knowing no kind.
 */
export function hasTileCounts(counters: EntityCounters): boolean {
  // A JSX element is truthy even when it renders null, so mounts ask this
  // before deciding whether the badge SUB-ROW exists at all.
  return tileCountBadgesOf(counters).length > 0;
}

export function TileCountBadges({ counters, humanAuthors, openKind, onToggleKind, expandableKind, controlsId, countOf }: {
  counters: EntityCounters;
  humanAuthors?: EntityBadges['humanMessageAuthors'];
  /** The kind whose relation group is open under this tile, if any. */
  openKind?: string | null;
  /**
   * Present ⇒ expandable badges become toggles for their relation group.
   * The badge's own `relation` spec (108's counted edge) rides along so the
   * host opens exactly the relation the number claims.
   */
  onToggleKind?: (kind: string, relation?: { type: string; direction: 'incoming' | 'outgoing' }) => void;
  /** The host's registry-derived answer to "can this kind expand at all?". */
  expandableKind?: (kind: string) => boolean;
  /** The relation group's DOM id, for the open toggle's `aria-controls`. */
  controlsId?: string;
  /**
   * THE SHARED-READ OVERRIDE (PR #272 re-review, blocking): once the host
   * can compute the counted relation from the SAME read that renders the
   * group's rows (same edge spec, same traversal path), that number wins
   * over the server counter — so a visible chip and its visible group can
   * never disagree, including the deterministic path-suppression case.
   * `undefined` ⇒ not computable yet (unhydrated): the counter remains the
   * DISCOVERY value. An override of ZERO removes the badge entirely — a
   * door onto a group the path has emptied is a door onto a lie.
   */
  countOf?: (kind: string, relation?: { type: string; direction: 'incoming' | 'outgoing' }) => number | undefined;
}) {
  const badges = tileCountBadgesOf(counters)
    .map((badge) => ({ badge, shown: countOf?.(badge.kind, badge.relation) ?? badge.count }))
    .filter(({ shown }) => shown > 0);
  if (badges.length === 0) return null;

  return (
    <span className="pn-st__counts" data-testid="tile-count-badges">
      {badges.map(({ badge, shown }) => {
        const isHuman = badge.emphasis === 'human';
        // The human badge's icon carries its own tooltip — the author names
        // when known, so a hover answers "who" as well as "how many" without
        // drawing a single extra pixel for it.
        const authorNames = isHuman && humanAuthors
          ? humanAuthors.actors.map((actor) => actor.displayName)
          : [];
        const authorOverflow = isHuman && humanAuthors ? Math.max(humanAuthors.total - authorNames.length, 0) : 0;
        const personTitle = authorNames.length > 0
          ? [...authorNames, authorOverflow > 0 ? `+${authorOverflow} more` : null].filter(Boolean).join(', ')
          : undefined;
        const body = (
          <>
            {isHuman
              ? <VectorIcon paths={PERSON_MARK} filled size={12} title={personTitle} />
              : <KindIcon kind={badge.icon} size={12} />}
            {shown}
          </>
        );
        const open = openKind === badge.kind;
        const classes = [
          'pn-st__count',
          badge.emphasis === 'human' ? 'pn-st__count--human' : '',
          open ? 'pn-st__count--open' : '',
        ].filter(Boolean).join(' ');
        const plural = `${shown} ${badge.label}${shown === 1 ? '' : 's'}`;
        return onToggleKind && expandableKind?.(badge.kind) ? (
          <button
            key={badge.kind}
            type="button"
            className={`${classes} pn-st__count--btn`}
            data-count-kind={badge.kind}
            data-relation-owner={controlsId}
            title={`${plural} — click to show them under this row`}
            /* The visible content is a bare number beside a decorative
               glyph, so the accessible name must say kind, count and
               action itself (PR #272 review, 3). */
            aria-label={`${open ? 'Hide' : 'Show'} ${plural} under this row`}
            aria-expanded={open}
            aria-controls={open ? controlsId : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onToggleKind(badge.kind, badge.relation);
            }}
          >
            {body}
          </button>
        ) : (
          <span
            key={badge.kind}
            className={classes}
            data-count-kind={badge.kind}
            title={plural}
          >
            {body}
          </span>
        );
      })}
    </span>
  );
}
