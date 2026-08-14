/**
 * TRIGGER GRAMMAR — the pure half of every sigil-opens-a-picker interaction.
 *
 * PROVENANCE: the `@` mention grammar in `channel-screen/Composer.tsx`,
 * generalized to any sigil so `/` (skills) and future triggers are the same
 * code path rather than a second implementation that drifts. The three rules
 * it carries are the composer's own, unchanged:
 *
 *  - START-OF-WORD ONLY. A sigil mid-word is content (`foo/bar`, `a@b.com`),
 *    not a request for a picker. The trigger exists only when the sigil
 *    follows whitespace or starts the text, and the query runs to the caret.
 *  - PREFIX, not substring. What the user typed after the sigil is the start
 *    of a name they are reaching for — matching mid-word makes the list churn
 *    with rows whose visible label does not begin with what was typed, which
 *    reads as "the filter is broken". Each whitespace-separated word of an
 *    option is a valid starting point so a surname or the second word of a
 *    title still reaches its row.
 *  - COMMIT REPLACES THE TRIGGER. The sigil-and-query text is spliced away and
 *    the committed text stands in its place; whitespace that immediately
 *    followed the trigger is absorbed because the committed text carries its
 *    own trailing separator.
 */

export interface TriggerRange {
  /** Offset of the sigil itself. */
  start: number;
  /** The caret — the trigger always ends where the user is typing. */
  end: number;
}

export interface ActiveTrigger {
  sigil: string;
  /** What was typed after the sigil, verbatim (filtering lowercases later). */
  query: string;
  range: TriggerRange;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The trigger the caret is currently inside, or null.
 *
 * Later sigils win: in `@alice /rev` with the caret at the end, the `/` is the
 * live trigger — the `@` word is settled text behind it. The query refuses
 * whitespace and a repeat of its own sigil, exactly as the mention grammar
 * did, so typing past the word closes the picker.
 */
export function activeTrigger(
  text: string,
  caret: number,
  sigils: readonly string[],
): ActiveTrigger | null {
  const upTo = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  let best: ActiveTrigger | null = null;
  for (const sigil of sigils) {
    const escaped = escapeRegExp(sigil);
    const match = new RegExp(`(?:^|\\s)${escaped}([^\\s${escaped}]*)$`).exec(upTo);
    if (!match) continue;
    const start = upTo.length - match[1]!.length - sigil.length;
    if (best === null || start > best.range.start) {
      best = { sigil, query: match[1]!, range: { start, end: upTo.length } };
    }
  }
  return best;
}

/**
 * Splice committed text over the trigger range and say where the caret lands.
 * Returned rather than applied — the caller owns both the draft state and the
 * DOM selection, and a caret left at its old offset after an insertion before
 * it is a cursor that has silently moved.
 */
export function commitTrigger(
  text: string,
  range: TriggerRange,
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end).replace(/^\s+/, '');
  return { text: `${before}${insert}${after}`, caret: before.length + insert.length };
}

export interface TriggerOption {
  id: string;
  display: string;
  /** Secondary line in a picker row (a description, a kind, a group). */
  meta?: string;
  group?: string;
}

/** The composer's prefix-word filter, verbatim. Case-insensitive. */
export function filterTriggerOptions<O extends TriggerOption>(
  options: readonly O[],
  query: string,
): O[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => {
    const display = option.display.toLowerCase();
    return display.startsWith(needle)
      || display.split(/\s+/).some((word) => word.startsWith(needle));
  });
}
