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
 */
export function hasTileCounts(counters: EntityCounters): boolean {
  // A JSX element is truthy even when it renders null, so mounts ask this
  // before deciding whether the badge SUB-ROW exists at all.
  return tileCountBadgesOf(counters).length > 0;
}

export function TileCountBadges({ counters, humanAuthors }: {
  counters: EntityCounters;
  humanAuthors?: EntityBadges['humanMessageAuthors'];
}) {
  const badges = tileCountBadgesOf(counters);
  if (badges.length === 0) return null;

  return (
    <span className="pn-st__counts" data-testid="tile-count-badges">
      {badges.map((badge) => (
        <span
          key={badge.kind}
          className={`pn-st__count${badge.emphasis === 'human' ? ' pn-st__count--human' : ''}`}
          data-count-kind={badge.kind}
          title={`${badge.count} ${badge.label}${badge.count === 1 ? '' : 's'}`}
        >
          <KindIcon kind={badge.iconKind} size={12} />
          {badge.kind === 'human-message' && humanAuthors
            ? <AvatarStack actors={humanAuthors.actors} total={humanAuthors.total} />
            : null}
          {badge.count}
        </span>
      ))}
    </span>
  );
}
