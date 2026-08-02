/**
 * The Discussion slot adapter — how the Thread reaches every Z3 panel.
 *
 * `EntityPanel` exposes `slots.discussion: (detail: EntityDetail) => ReactNode`
 * (and `EntityFullView` the same). This factory returns exactly that function,
 * so a screen writes:
 *
 *   <EntityPanel entityId={id} slots={{ discussion: discussionSlot() }} />
 *
 * and every kind's Discussion tab is the real Thread, anchored on that entity.
 * Variant is a data lookup, never a kind branch: the kinds that read as a room
 * get the feed treatment, everything else gets comments.
 */
import type { ReactNode } from 'react';
import type { EntityDetail, EntityKind } from '../../types/contract';
import { Thread } from './Thread';
import type { ThreadProps, ThreadVariant } from './types';

/** Anchors whose discussion is a room, not a comment list. */
const FEED_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['channel']);

export function variantForKind(kind: EntityKind): ThreadVariant {
  return FEED_KINDS.has(kind) ? 'feed' : 'comments';
}

export type DiscussionSlotOptions = Omit<ThreadProps, 'anchorId' | 'variant'> & {
  /** Pin the variant instead of deriving it from the anchor's kind. */
  variant?: ThreadVariant;
};

/** `EntityPanelSlots['discussion']` / `EntityFullViewSlots['discussion']`. */
export function discussionSlot(
  options: DiscussionSlotOptions = {},
): (detail: EntityDetail) => ReactNode {
  const { variant, ...rest } = options;
  return (detail: EntityDetail): ReactNode => (
    <Thread
      key={detail.id}
      anchorId={detail.id}
      variant={variant ?? variantForKind(detail.kind)}
      {...rest}
    />
  );
}

/** Same thing as a component, for JSX-shaped call sites. */
export function DiscussionPanel({ detail, ...options }: { detail: EntityDetail } & DiscussionSlotOptions) {
  const { variant, ...rest } = options;
  return (
    <Thread
      anchorId={detail.id}
      variant={variant ?? variantForKind(detail.kind)}
      {...rest}
    />
  );
}
