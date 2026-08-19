/**
 * THE POST-MORTEM MODEL — every number the exited canvas shows, and the one
 * rule that governs all of them.
 *
 * HOLLOW IS NOT ZERO, and in this file that is a type-level fact rather than a
 * style preference. `SessionTranscriptStats`' four token fields are
 * `number | null` (contract.ts) and the null is LOAD-BEARING: it means *the
 * provider did not report*, which is a different claim from *the provider
 * reported nothing was spent*. A Codex session whose dialect carries no usage
 * renders `—`; a session that genuinely burned no cache renders `0`. Collapsing
 * the two — which is what `{value && <X/>}` does, and what the prior art does
 * at SubagentCard.tsx:86 — states a measurement nobody took.
 *
 * So: NOTHING in this module or its renderer gates on truthiness. Every
 * nullable value goes through `formatTokens`, which branches on `== null` and
 * on nothing else, and a genuine `0` reaches the DOM as the string `0`.
 *
 * WHY THESE ARE PURE FUNCTIONS over a plain shape rather than methods on the
 * page: jsdom cannot see colour or layout, so the only part of this surface a
 * test can hold to account is the arithmetic and the words. Keeping them here,
 * `now` injected rather than read, makes the whole numeric surface provable
 * without rendering anything.
 */
import type { SessionTranscriptStats } from '@tm8/contract';
import { relTime, shortDate } from '../kit/time';

/**
 * The mark for "we were not told". One constant, because the difference
 * between an em-dash and a hyphen is invisible in review and this string is
 * the entire signal that a number is absent rather than zero.
 */
export const HOLLOW = '—';

/**
 * A count the provider may not have reported.
 *
 * Exact digits with thousands separators, never a compact `18.2k`. The prior
 * art shipped FOUR disagreeing compact formatters and a dead branch between
 * two identical ones; more to the point, a post-mortem is read to answer "how
 * much did this cost me", and rounding the answer to two significant figures
 * on a screen with room for six is a loss for no gain.
 */
export function formatTokens(value: number | null | undefined): string {
  if (value == null) return HOLLOW;
  return value.toLocaleString('en-US');
}

/** A count that is always known — message and tool tallies are never nullable. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The derived token total, and whether it is the whole story.
 *
 * `complete: false` means at least one of the four was hollow, so the sum is a
 * sum of WHAT WAS REPORTED and understates the session. That distinction has
 * to travel with the number — a partial sum rendered as a total is exactly the
 * "confidently wrong" failure the null exists to prevent. Null when all four
 * are hollow: there is no total to show, not a zero one.
 */
export function tokenTotal(
  stats: Pick<
    SessionTranscriptStats,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
  >,
): { value: number; complete: boolean } | null {
  const parts = [
    stats.inputTokens,
    stats.outputTokens,
    stats.cacheReadTokens,
    stats.cacheCreationTokens,
  ];
  const reported = parts.filter((p): p is number => p != null);
  if (reported.length === 0) return null;
  return {
    value: reported.reduce((sum, n) => sum + n, 0),
    complete: reported.length === parts.length,
  };
}

/** The four token lines, in the order the bar draws them. */
export const TOKEN_KINDS = [
  { key: 'inputTokens', label: 'input' },
  { key: 'outputTokens', label: 'output' },
  { key: 'cacheReadTokens', label: 'cache read' },
  { key: 'cacheCreationTokens', label: 'cache create' },
] as const satisfies readonly {
  key: keyof Pick<
    SessionTranscriptStats,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
  >;
  label: string;
}[];

/**
 * Each token kind's share of the reported total, for the proportion bar.
 *
 * A HOLLOW FIELD GETS NO SEGMENT — not a zero-width one. A bar drawn over a
 * partial sum would show cache-read at 100% of a session whose input was
 * simply never reported, which reads as a fact about the session rather than
 * about the transcript. `complete: false` is the renderer's cue to label the
 * bar as covering only what was reported.
 */
export function tokenShares(
  stats: Pick<
    SessionTranscriptStats,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
  >,
): { key: string; label: string; value: number; pct: number }[] {
  const total = tokenTotal(stats);
  if (total === null || total.value === 0) return [];
  return TOKEN_KINDS.flatMap(({ key, label }) => {
    const value = stats[key];
    if (value == null) return [];
    return [{ key, label, value, pct: (value / total.value) * 100 }];
  });
}

/**
 * `41m` / `1h 5m` / `45s` — a difference of two RECORDED timestamps, so unlike
 * a relative label this is not a clock read and never goes stale.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * How long the session ran, or null when the record cannot say.
 *
 * Null on a missing OR unparseable endpoint, and null on a negative span: a
 * session that records an end before its start is a broken record, and
 * printing `0s` for it would launder the breakage into a measurement.
 */
export function sessionDurationMs(
  startedAt: string | null | undefined,
  exitedAt: string | null | undefined,
): number | null {
  if (startedAt == null || exitedAt == null) return null;
  const from = Date.parse(startedAt);
  const to = Date.parse(exitedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
}

/**
 * THE VERDICT WORD — and the reason `failed` is not spelt `exited`.
 *
 * `TerminalBody` maps both statuses onto this one canvas, and until now both
 * read "Session exited" while the presentation layer two rows down correctly
 * said `failed` (drift D3 in HANDOVER-SessionAnatomy.md). The strip and the
 * interior disagreed about the same session. There is deliberately NO exit
 * code in either word: the contract's `work_session` state arm carries none on
 * any node (contract.ts:277-279), so a number here would be invented.
 */
export function outcomeTitle(outcome: 'exited' | 'failed'): string {
  return outcome === 'failed' ? 'Session failed' : 'Session exited';
}

/**
 * `ran 41m · ended 4h ago` — the exit facts, which have never once rendered.
 *
 * `ExitedFallback` has accepted a `meta` string for exactly this since it was
 * written and its only caller passed none (drift D1,
 * HANDOVER-SessionAnatomy.md:88), so the oracle's fact line has been dead prop
 * the whole time. This is the assembly, and the string prop is superseded
 * rather than finally fed: composing it here means the same record produces the
 * same line on every host, and there is no second place for a caller to invent
 * a different one.
 *
 * NAMING AN ENDING WE DO NOT HAVE is the failure this is shaped around. A
 * session with no recorded `exitedAt` says so — it does not borrow `now` to
 * manufacture a duration, and it does not print `0s`. An unrecorded end is a
 * real state (the row was written by a node that died before it could close
 * out) and it reads as one.
 *
 * `now` is a PARAMETER. Every relative label in this app resolves through
 * `kit/time`'s single injected clock for the same two reasons: one interval for
 * the whole document, and a render that a test can pin to an instant.
 */
export function exitFactsLine({
  startedAt,
  exitedAt,
  now,
}: {
  startedAt: string | null | undefined;
  exitedAt: string | null | undefined;
  now: number;
}): string {
  const parts: string[] = [];
  const ms = sessionDurationMs(startedAt, exitedAt);
  if (ms === null) {
    const started = shortDate(startedAt ?? null, now);
    if (started !== '') parts.push(`started ${started}`);
    parts.push('duration not recorded');
  } else {
    parts.push(`ran ${formatDuration(ms)}`);
  }

  const ended = relTime(exitedAt ?? null, now);
  parts.push(ended === '' ? 'no end recorded' : `ended ${ended}`);
  return parts.join(' · ');
}
