/**
 * THE TOP-BAR SEGMENT (Attention v2, chapter 4 "Top bar"): two sections,
 * `Personal n` and `Team n`. Personal counts roll-up roots with a request
 * assigned to the viewer (the member running the session that raised it);
 * Team counts every pending root in the space — everyone can see every
 * request. Both include FYI and ignore Seen.
 *
 * A section with anything waiting GLOWS (a slow pulse, still under
 * prefers-reduced-motion): Personal in the colour of its loudest request,
 * Team in a softer amber. Clicking a section opens the `AttentionList` as a
 * popover on that filter.
 *
 * Renders nothing without a provider, so the strip can mount it unconditionally.
 */
import { useCallback, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import { useAttentionOptional } from './attention-store';
import { levelRank } from './attention-selectors';
import type { AttentionChip, AttentionFilter } from './attention-selectors';
import { AttentionList } from './AttentionList';
import './attention-v2.css';

export interface AttentionTopSegmentProps {
  onOpenEntity(id: EntityId): void;
  nameOf?(id: EntityId): { title: string } | undefined;
}

export function AttentionTopSegment({ onOpenEntity, nameOf }: AttentionTopSegmentProps) {
  const api = useAttentionOptional();
  const [open, setOpen] = useState<AttentionFilter | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(null), []);
  useDismissable(open !== null, box, close);
  if (!api) return null;

  const counts = api.counts();
  const loudest = api.queue('mine').reduce<AttentionChip | null>(
    (best, row) => (!best || levelRank(row.chip.level) > levelRank(best.level) ? row.chip : best),
    null,
  );
  // A failed read is NOT an all-clear: it has its own face, never a 0.
  const failed = api.status === 'error';
  const loading = api.status === 'loading';
  const sections: { key: AttentionFilter; name: string; count: number; tone: string }[] = [
    { key: 'mine', name: 'Personal', count: counts.mine, tone: counts.mine > 0 ? loudest?.tone ?? 'wait' : 'clear' },
    { key: 'all', name: 'Team', count: counts.all, tone: counts.all > 0 ? 'team' : 'clear' },
  ];

  return (
    <span className="att-top" ref={box} data-testid="attention-top-segment">
      {failed ? (
        <button
          type="button"
          className="status-strip__segment att-top__btn att-top__btn--fyi"
          data-testid="attention-top-failed"
          aria-haspopup="true"
          aria-expanded={open !== null}
          title="Attention could not be loaded"
          onClick={() => setOpen((value) => (value ? null : 'all'))}
        >
          <span>attention unavailable</span>
          <span className="att-top__bang" aria-hidden>—</span>
        </button>
      ) : (
        sections.map((section) => {
          const label = loading
            ? `Loading ${section.name.toLowerCase()} attention`
            : `${section.name} attention: ${section.count === 0 ? 'nothing waiting' : `${section.count} waiting`}`;
          return (
            <button
              key={section.key}
              type="button"
              className={[
                'status-strip__segment att-top__btn',
                `att-top__btn--${section.tone}`,
                !loading && section.count > 0 ? 'att-top__btn--glow' : null,
              ].filter(Boolean).join(' ')}
              data-testid={`attention-top-${section.key}`}
              aria-haspopup="true"
              aria-expanded={open === section.key}
              aria-label={label}
              title={label}
              onClick={() => setOpen((value) => (value === section.key ? null : section.key))}
            >
              <span className="att-top__name">{section.name}</span>
              <span className="att-top__count" data-testid={`attention-top-${section.key}-count`}>
                {loading ? '…' : section.count}
              </span>
            </button>
          );
        })
      )}
      {open ? (
        <div className="att-top__pop" role="dialog" aria-label="Attention" data-testid="attention-top-popover">
          <AttentionList
            key={open}
            filter={open}
            title={open === 'mine' ? 'Personal' : 'Team'}
            nameOf={nameOf}
            onOpen={(id) => {
              setOpen(null);
              onOpenEntity(id);
            }}
          />
        </div>
      ) : null}
    </span>
  );
}
