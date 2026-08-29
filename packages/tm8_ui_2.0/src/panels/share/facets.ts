import type { HandoffView } from '@tm8/contract';
import type { PillTone } from '../../kit';

/**
 * THE TWO-FACET LAW (L7, LLD §8) rendered as data.
 *
 * A handoff has TWO independent truths and they fail independently:
 *   · deliveryStatus — did the payload reach the session's context?
 *   · recordStatus   — did the durable record of the share land?
 *
 * They are rendered as TWO PILLS, always both present, never merged. The
 * cases that make the law non-negotiable:
 *   · `delivered × failed` — the agent HAS it, but nothing recorded that;
 *   · `unknown × recorded` — we wrote it down and cannot prove it arrived.
 * Collapsed into one badge, both become "partly worked", which destroys the
 * only distinction that tells a user whether to share again.
 *
 * `unknown` NEVER wears the success treatment. It is wait-amber with a
 * warning glyph, and the canvas is explicit about why: unknown is a warning,
 * never a success.
 *
 * COPY PROVENANCE. T0-2 freezes three visuals (`delivered ✓`,
 * `delivery unknown ⚠`, `recorded`); T4's share family adds refused (block,
 * cross glyph), withdrawn (wait + audit line) and source-missing (dashed +
 * bare amber word). The remaining pairs — the in-flight delivery states and
 * the non-terminal record states — have no frozen pixels, so their copy is
 * authored HERE against the established grammar (green = proven good, amber =
 * warn/partial, red = failed, grey = neutral//in-progress) and ledgered as a
 * D-entry. Authored, not invented: every word states the fact and nothing
 * more.
 */

export interface FacetView {
  /** The WORD, with its canvas glyph where one is frozen. */
  label: string;
  tone: PillTone;
  /** Longer statement for title/aria — the pill is small, the truth is not. */
  detail: string;
}

const DELIVERY: Record<HandoffView['deliveryStatus'], FacetView> = {
  prepared: {
    label: 'preparing',
    tone: 'idle',
    detail: 'Prepared, not sent yet — nothing has reached the session.',
  },
  dispatching: {
    label: 'sending',
    tone: 'idle',
    detail: 'In flight — the payload is on its way to the session.',
  },
  delivered: {
    label: 'delivered ✓',
    tone: 'run',
    detail: 'The session received this into its context.',
  },
  refused: {
    label: 'refused ✗',
    tone: 'block',
    detail: 'The session refused this payload — it was not added to its context.',
  },
  unknown: {
    // The flagship honesty state. Amber and worded, never the green of proof.
    label: 'delivery unknown ⚠',
    tone: 'wait',
    detail:
      'Delivery is unconfirmed either way — most often the node restarted mid-send. The session may or may not have received this.',
  },
};

const RECORD: Record<HandoffView['recordStatus'], FacetView> = {
  pending: {
    label: 'recording',
    tone: 'idle',
    detail: 'The durable record of this share has not landed yet.',
  },
  recorded: {
    label: 'recorded',
    tone: 'idle',
    detail: 'The share is recorded in the entity graph.',
  },
  failed: {
    label: 'record failed',
    tone: 'block',
    detail:
      'The durable record did not land. Whatever the delivery facet says stands on its own — this share may not survive a reload.',
  },
  withdrawn: {
    label: 'withdrawn',
    tone: 'wait',
    detail:
      'Withdrawn after the fact. The withdrawal decorates the record; nothing is deleted from history.',
  },
};

export function deliveryFacet(h: HandoffView): FacetView {
  return DELIVERY[h.deliveryStatus];
}

export function recordFacet(h: HandoffView): FacetView {
  return RECORD[h.recordStatus];
}

/**
 * The ONE place that may claim a share fully worked: both facets positive.
 * Anything else — including `delivered × pending` — is not done yet, and the
 * row must not read as if it were.
 */
export function isFullySettled(h: HandoffView): boolean {
  return h.deliveryStatus === 'delivered' && h.recordStatus === 'recorded';
}

/** Audit sentence for a withdrawn share (T4: "decorates, never rewrites"). */
export function withdrawalAudit(h: HandoffView): string | null {
  if (h.recordStatus !== 'withdrawn' || !h.withdrawnAt) return null;
  const who = h.withdrawnBy?.displayName ?? 'someone';
  const why = h.withdrawReason ? ` — ${h.withdrawReason}` : '';
  return `withdrawn by ${who}${why}; the session may have already read it, and the withdrawal is itself recorded`;
}
