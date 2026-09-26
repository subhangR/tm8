/**
 * THE TOP-BAR SEGMENT (Attention v2, chapter 4 "Top bar", mock tab 2):
 * `! 2 mine · 7 all`, the first segment of the status strip. Both numbers count
 * roll-up roots, include FYI, and ignore Seen. Its colour follows the highest
 * level among "mine" (amber when only others' requests wait). Clicking it opens
 * the `AttentionList` as a popover.
 *
 * Renders nothing without a provider, so the strip can mount it unconditionally.
 */
import { useCallback, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import { useAttentionOptional } from './attention-store';
import { levelRank } from './attention-selectors';
import type { AttentionChip } from './attention-selectors';
import { AttentionList } from './AttentionList';
import './attention-v2.css';

export interface AttentionTopSegmentProps {
  onOpenEntity(id: EntityId): void;
  nameOf?(id: EntityId): { title: string } | undefined;
}

export function AttentionTopSegment({ onOpenEntity, nameOf }: AttentionTopSegmentProps) {
  const api = useAttentionOptional();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, box, close);
  if (!api) return null;

  const counts = api.counts();
  const mine = api.queue('mine');
  const loudest = mine.reduce<AttentionChip | null>(
    (best, row) => (!best || levelRank(row.chip.level) > levelRank(best.level) ? row.chip : best),
    null,
  );
  const tone = counts.all === 0 ? 'clear' : loudest?.tone ?? 'wait';
  const label = api.status === 'loading'
    ? 'Loading attention'
    : counts.all === 0
      ? 'Nothing needs you'
      : `${counts.mine} need you, ${counts.all} need anyone`;

  return (
    <span className="att-top" ref={box}>
      <button
        type="button"
        className={`status-strip__segment att-top__btn att-top__btn--${tone}`}
        data-testid="attention-top-segment"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="att-top__bang" aria-hidden>{counts.all === 0 ? '✓' : loudest?.icon ?? '!'}</span>
        {api.status === 'loading' ? (
          <span>…</span>
        ) : counts.all === 0 ? (
          <span>nothing needs you</span>
        ) : (
          <span data-testid="attention-top-counts">{`${counts.mine} mine · ${counts.all} all`}</span>
        )}
      </button>
      {open ? (
        <div className="att-top__pop" role="dialog" aria-label="Needs you" data-testid="attention-top-popover">
          <AttentionList
            nameOf={nameOf}
            onOpen={(id) => {
              setOpen(false);
              onOpenEntity(id);
            }}
          />
        </div>
      ) : null}
    </span>
  );
}
