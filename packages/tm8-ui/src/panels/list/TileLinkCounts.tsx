import type { EntityCounters } from '@tm8/contract';
import { KindIcon, tileLinkCountsOf } from '../../domain';

/**
 * THE COUNTS LINE — glyph+number for what this entity produced, in the fixed
 * order `TILE_LINK_GROUPS` declares (design doc 01a1465d §6).
 *
 * It replaces `TileCountBadges`, which drew docs, memories and three
 * variations of a MESSAGE TALLY. The message counts are gone from every tile
 * by the approved change list ("all message / human / agent message counts"):
 * a number that ticks on every turn of every chat was the loudest thing on a
 * row and said the least about it.
 *
 * WHICH groups and both honesty rules live in `domain/tile-counts.ts` — §15.2:
 * this component renders numbers and knows no kind. The glyphs are the
 * registry's own marks (KindIcon), so a doc on this line and a doc in the list
 * are the same drawing.
 *
 * A COUNT IS A DOOR, AND THE DOOR OPENS SIDEWAYS. Clicking a number opens that
 * group in the DETAIL PANEL (`onOpenGroup`), never as rows expanded inline
 * under the tile — that was the relation accordion, and the ruling of
 * 2026-10-16 removed it: a row that grows other rows under it makes the list
 * unscannable and put the list's own height at the mercy of its graph. Without
 * `onOpenGroup` the numbers are plain text, which is what they are on a
 * surface with no detail panel to open.
 */
export function TileLinkCounts({
  counters,
  entityId,
  onOpenGroup,
  hiddenGroups,
}: {
  counters: EntityCounters;
  entityId: string;
  /** Group ids the viewer turned off in List settings; those counts are not drawn. */
  hiddenGroups?: ReadonlySet<string>;
  /** Present ⇒ each count is a button that opens its group in the detail panel. */
  onOpenGroup?: (entityId: string, groupKind: string) => void;
}) {
  const counts = tileLinkCountsOf(counters, hiddenGroups);
  if (counts.length === 0) return null;

  return (
    <span className="lp__counts" data-testid="tile-link-counts">
      {counts.map(({ group, count }) => {
        /* The visible content is a decorative glyph and a bare number, so the
           accessible name has to carry kind, count and action by itself. */
        const plural = `${count} ${group.label}${count === 1 ? '' : 's'}`;
        const body = (
          <>
            <KindIcon kind={group.kind} size={12} />
            {count}
          </>
        );
        return onOpenGroup ? (
          <button
            key={group.id}
            type="button"
            className="lp__count lp__count--btn"
            data-count-kind={group.id}
            title={`${plural} — open in the detail panel`}
            aria-label={`Open ${plural} in the detail panel`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenGroup(entityId, group.kind);
            }}
          >
            {body}
          </button>
        ) : (
          <span key={group.id} className="lp__count" data-count-kind={group.id} title={plural}>
            {body}
          </span>
        );
      })}
    </span>
  );
}
