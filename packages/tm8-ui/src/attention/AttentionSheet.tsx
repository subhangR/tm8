/**
 * PHONE (chapter 4 "Phone", mock tab 7): the header button and the bottom
 * sheet it opens.
 *
 * The button is the top-bar segment folded to one number: `! 2`, the MINE
 * count, coloured by the loudest mine chip. With nothing mine but something
 * waiting on anyone it shows the all count, muted, so the phone never reads
 * "nothing" while the desktop reads `0 mine · 7 all`. Tapping opens the sheet
 * with the SAME list component the popover uses; the list's own Mine/All
 * filter is the "filter for all".
 *
 * Renders nothing outside an `AttentionProvider`, and nothing when no request
 * is open anywhere — the phone header is 53px shared by five things.
 */
import type { EntityId } from '@tm8/contract';
import { MobileSheet } from '../mobile/MobileSheet';
import { AttentionList, useAttentionOptional } from './index';
import './attention-surfaces.css';

/**
 * The header button. The SHEET is rendered by the shell, inside its
 * `MobileSurfaceProvider` — the header sits outside it, and `MobileSheet`
 * portals through that context, so a sheet mounted here would have no host.
 */
export function AttentionHeaderButton(props: { expanded: boolean; onOpen(): void }) {
  const api = useAttentionOptional();
  if (!api) return null;
  const { mine, all } = api.counts();
  if (all === 0) return null;
  const showMine = mine > 0;
  const lead = api.queue(showMine ? 'mine' : 'all')[0];
  const tone = showMine ? (lead?.chip.tone ?? 'wait') : 'muted';
  return (
    <button
      type="button"
      className={`att-phone-btn att-phone-btn--${tone}`}
      data-testid="attention-phone-button"
      aria-haspopup="dialog"
      aria-expanded={props.expanded}
      aria-label={`Needs you: ${mine} mine, ${all} all`}
      onClick={props.onOpen}
    >
      <span aria-hidden="true">{lead?.chip.icon ?? '!'}</span>
      <span>{showMine ? mine : all}</span>
    </button>
  );
}

export function AttentionSheet(props: { onDismiss(): void; onOpenEntity(id: EntityId, kind: string | null): void }) {
  const api = useAttentionOptional();
  if (!api) return null;
  const { mine, all } = api.counts();
  return (
    <MobileSheet
      title={`Needs you · ${mine > 0 ? mine : all}`}
      onDismiss={props.onDismiss}
      testId="attention-phone-sheet"
    >
      <div className="att-phone-sheet">
        <AttentionList
          filter={mine > 0 ? 'mine' : 'all'}
          onOpen={(id) => props.onOpenEntity(id, api.queue('all').find((row) => row.rootId === id)?.kind ?? null)}
          compact
        />
      </div>
    </MobileSheet>
  );
}
