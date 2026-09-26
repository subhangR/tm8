/**
 * THE CHIP (Attention v2, chapter 4 "The chip"): one indicator on every
 * surface that shows an entity. It reads `<icon> <points>`, then `· ×n` when
 * more than one request is pending, then the age of the oldest (`· 3h`).
 *
 *   fyi            i  grey
 *   normal / high  !  amber (--pn-wait)
 *   urgent         !  red   (--pn-block)
 *
 * `EntityAttentionChip` is what surfaces mount: it asks the store for the
 * entity's chip (and, for a session or chat, the F1 raised-by marker) and
 * renders nothing when nothing is pending or when no provider is above it.
 */
import type { AttentionChip } from './attention-selectors';
import { formatAge } from './attention-selectors';
import { useAttentionOptional } from './attention-store';
import type { AttentionEntityRef } from './attention-store';
import './attention-v2.css';

export function chipText(chip: AttentionChip, now: number): string {
  const count = chip.pendingCount > 1 ? ` · ×${chip.pendingCount}` : '';
  return `${chip.totalPoints}${count} · ${formatAge(chip.oldestRequestedAt, now)}`;
}

export function chipLabel(chip: AttentionChip, now: number): string {
  const requests = chip.pendingCount === 1 ? '1 request' : `${chip.pendingCount} requests`;
  return `Needs attention (${chip.level}): ${requests}, ${chip.totalPoints} points, waiting ${formatAge(chip.oldestRequestedAt, now)}. ${chip.latestReason}`;
}

export interface AttentionChipViewProps {
  chip: AttentionChip;
  /** `compact` drops the count and age: for tabs and far-zoom graph cards. */
  compact?: boolean;
  className?: string;
  now?: number;
}

export function AttentionChipView({ chip, compact = false, className, now = Date.now() }: AttentionChipViewProps) {
  return (
    <span
      className={['att-chip', `att-chip--${chip.tone}`, className].filter(Boolean).join(' ')}
      data-testid="attention-chip"
      data-level={chip.level}
      title={chipLabel(chip, now)}
      aria-label={chipLabel(chip, now)}
      role="img"
    >
      <span className="att-chip__b" aria-hidden>{chip.icon}</span>
      <span aria-hidden>{compact ? String(chip.totalPoints) : chipText(chip, now)}</span>
    </span>
  );
}

/** The chip for one entity, from the store. Null without a provider or when clear. */
export function useEntityChip(entity: AttentionEntityRef): AttentionChip | null {
  const api = useAttentionOptional();
  if (!api) return null;
  return api.chipFor(entity) ?? api.raisedChipFor(entity.id);
}

export function EntityAttentionChip({ entity, ...rest }: { entity: AttentionEntityRef } & Omit<AttentionChipViewProps, 'chip'>) {
  const chip = useEntityChip(entity);
  return chip ? <AttentionChipView chip={chip} {...rest} /> : null;
}
