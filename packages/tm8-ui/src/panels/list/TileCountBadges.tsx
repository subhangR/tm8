import type { EntityBadges, EntityCounters } from '@tm8/contract';
import { KindIcon, tileCountBadgesOf } from '../../domain';
import { AvatarStack } from '../../kit';

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

export function TileCountBadges({ counters, humanAuthors, openKind, onToggleKind, expandableKind, controlsId }: {
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
}) {
  const badges = tileCountBadgesOf(counters);
  if (badges.length === 0) return null;

  return (
    <span className="pn-st__counts" data-testid="tile-count-badges">
      {badges.map((badge) => {
        const body = (
          <>
            <KindIcon kind={badge.icon} size={12} />
            {badge.emphasis === 'human' && humanAuthors
              ? <AvatarStack actors={humanAuthors.actors} total={humanAuthors.total} />
              : null}
            {badge.count}
          </>
        );
        const open = openKind === badge.kind;
        const classes = [
          'pn-st__count',
          badge.emphasis === 'human' ? 'pn-st__count--human' : '',
          open ? 'pn-st__count--open' : '',
        ].filter(Boolean).join(' ');
        const plural = `${badge.count} ${badge.label}${badge.count === 1 ? '' : 's'}`;
        return onToggleKind && expandableKind?.(badge.kind) ? (
          <button
            key={badge.kind}
            type="button"
            className={`${classes} pn-st__count--btn`}
            data-count-kind={badge.kind}
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
