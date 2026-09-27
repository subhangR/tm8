/**
 * HOME MODEL — the one summary→row projection, `homeRowOf`.
 *
 * No React, no seam, no DOM: given a summary and the seam's liveness VERDICT,
 * this produces the word, tone and dot a row draws. The fleet rows
 * (`chat-home/fleet/fleet-rows.ts`) consume it. The T5-1 `composeMyWork`
 * sections that once lived here fed Home's NEEDS YOU strip; that strip was
 * removed (Subhang, 2026-09-27) — attention's entry is the tab bar — and the
 * composition went with it.
 *
 * TWO LAWS THIS FILE EXISTS TO KEEP (each one is load-bearing):
 *
 *  1. **The verdict outranks the record (D39/D6/R-UI-5).** A session's word and
 *     tone come from the registry's `liveTreatment(verdict)` where one exists,
 *     never from `state.status`. This file never computes a verdict — it is
 *     handed one and asks the registry what it means.
 *  2. **No kind literal (§15.2).** Everything here is answered by REGISTRY
 *     DATA, keyed by capability or status source, never by naming a kind.
 */
import type { EntitySummary } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import { getKind } from '../domain';
import type { StatusSource } from '../domain/types';
import type { PillTone } from '../kit';

// ---------------------------------------------------------------------------
// Status projection (registry DATA, keyed by SOURCE — never by kind)
// ---------------------------------------------------------------------------

/**
 * `StatusSource` → the `EntityState` member it names. Copied in shape from
 * `panels/detail/chrome.tsx`, which keeps the same table for the header pill;
 * that one is module-private, so this is a duplicate rather than an import.
 * FLAGGED in HANDOVER.md as a promote-to-`domain/` candidate: two copies of a
 * mapping table is exactly how a mapping drifts.
 */
const STATUS_FIELD: Record<Exclude<StatusSource, 'none'>, string> = {
  status: 'status',
  sessionStatus: 'status',
  // A container's nine-value lifecycle also lands on `EntityState.status`.
  containerStatus: 'status',
  prState: 'state',
  profileStatus: 'status',
  memberRole: 'role',
  equipped: 'equipped',
};

export function statusValueOf(source: StatusSource, state: unknown): string | null {
  if (source === 'none') return null;
  const bag = state as Record<string, unknown>;
  const raw = bag?.[STATUS_FIELD[source]];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw ? 'equipped' : 'library';
  return null;
}

// ---------------------------------------------------------------------------
// The row Home draws
// ---------------------------------------------------------------------------

/**
 * The dot that leads a row. `pulse` is the ACTIVITY marker and is only ever
 * reachable through a `live` verdict (the two-source law, F1/D6) — this type
 * cannot express a pulsing row that is not live, because `homeRowOf` is the
 * only constructor and it gates the promotion.
 */
export type HomeDot = 'solid' | 'pulse' | 'ring' | null;

export interface HomeRow {
  id: string;
  /** The row's KIND — the screen draws its registry mark. */
  kind: string;
  title: string;
  /** Status WORD. Status is always colour + word, never colour alone (C8/L10). */
  word: string | null;
  tone: PillTone;
  dot: HomeDot;
  /**
   * The long-form honest sentence for the degraded verdicts, carried on
   * `title=` so the short word never loses its explanation (D34).
   */
  detail?: string;
}

export interface HomeRowOpts {
  /** The seam VERDICT for this row, where its kind has one. */
  liveness?: SessionLiveness;
  /** §9.2 pool byte-activity. Can only REFINE a live verdict, never promote. */
  streaming?: boolean;
  /** Force the compact word (the 320 floor); falls back to the long label. */
  compact?: boolean;
}

/**
 * Project one summary into a Home row. The status half is entirely registry
 * data + the seam verdict; this function chooses nothing.
 */
export function homeRowOf(summary: EntitySummary, opts: HomeRowOpts = {}): HomeRow {
  const config = getKind(summary.kind);
  const kind = summary.kind;

  // PRECEDENCE (D39): where a liveTreatment exists it OWNS the presentation.
  // The record's claim is not discarded — the registry's authored label states
  // and withdraws it in one breath ("running per record · unverified").
  const treatment =
    opts.liveness && config.list.liveTreatment ? config.list.liveTreatment(opts.liveness) : null;

  if (treatment) {
    // The streaming word is reachable ONLY from a verdict that offers one, so
    // activity can refine `live` and can never promote `stale`/`unknown`.
    const streaming = opts.streaming === true && treatment.streamingLabel !== undefined;
    const word = streaming
      ? treatment.streamingLabel
      : opts.compact
        ? (treatment.shortLabel ?? treatment.label)
        : treatment.label;
    return {
      id: summary.id,
      kind,
      title: summary.title,
      word: word ?? treatment.label,
      tone: treatment.tone,
      dot: streaming ? 'pulse' : treatment.dot === 'solid' ? 'solid' : 'ring',
      detail: treatment.reason,
    };
  }

  const spec = config.panel.statusPill;
  const source: StatusSource = spec?.source ?? 'none';
  const value = statusValueOf(source, summary.state);
  if (!spec || value === null) {
    return { id: summary.id, kind, title: summary.title, word: null, tone: 'idle', dot: null };
  }
  return {
    id: summary.id,
    kind,
    title: summary.title,
    word: spec.labels?.[value] ?? value.replace(/_/g, ' '),
    tone: spec.tones[value] ?? 'idle',
    // The oracle draws task dots as filled for blocked and ringed otherwise;
    // "filled" is the loud state, so the tone that means blocked fills.
    dot: spec.tones[value] === 'block' ? 'solid' : 'ring',
  };
}
