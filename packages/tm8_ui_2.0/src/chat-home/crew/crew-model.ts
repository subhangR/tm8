/**
 * THE CREW VIEW-MODEL — everything the Crew Card and the Live Dock need to
 * say, computed once, with no React and no clock.
 *
 * WHY BOTH SURFACES SHARE ONE FOLD. The card lives in the transcript and the
 * dock lives above the composer; they are the two halves of the approved A+C
 * pairing and they describe THE SAME CREW. If each counted its own helpers,
 * the strip above the composer could read "2 working" over a card that says
 * "1 needs you · 1 working" — two truths on one screen, which is worse than
 * either alone. So counting, ordering and phrasing happen here and the
 * components only lay them out.
 *
 * PURE, AND CLOCKLESS ON PURPOSE. The host passes both `startedAt` and its
 * own `now`; nothing here reads the clock, so every fold is deterministic and
 * testable. The two time phrases themselves are formatted by `kit/time.ts`,
 * which is the package's ONLY date formatter — a rule with its own guard in
 * `kit/timestamp.test.tsx`, and one this file originally broke by writing
 * "4 minutes ago" by hand.
 *
 * FIXTURE-DRIVEN, BY DESIGN AND FOR NOW. Nothing here reads a session, a
 * seam or a feed. `HelperView` is the shape a host must hand over, and
 * producing it from real work-session facts is DESIGN 2's job (task
 * 01a028e1). Until that lands, the only producers are the fixtures beside
 * this file.
 */
import { elapsed, relTime } from '../../kit';
import {
  CREW_FACET_ORDER,
  facetWord,
  helperCountWords,
  helperWordsOf,
  type CrewFacet,
  type HelperTone,
  type HelperWords,
} from './status-vocabulary';

/**
 * One helper, as a host describes it.
 *
 * NOTE WHAT IS NOT HERE: no session id field, no status enum import, no
 * entity kind. `role` is the identity a person sees, and it is REQUIRED —
 * there is no fallback to an id, because a fallback to an id is how ids reach
 * screens.
 */
export interface HelperView {
  /**
   * React key and the host's correlation handle. AN ENTITY ID USUALLY LIVES
   * HERE, and it is the one field the components must never render — the
   * fixtures use real uuid-shaped values precisely so the leak guard has
   * something to catch if that ever changes.
   */
  key: string;
  /** "Drafter", "Tester", "Reviewer". What the helper is FOR. Never an id. */
  role: string;
  /**
   * One of the eight presentation states, as a `string` rather than
   * `HelperStatus`. The host is ultimately quoting a server field, and a
   * component that only accepted the known union would push the unknown case
   * out to the caller — see `helperWordsOf`.
   */
  state: string;
  /** The live line, when there is one. Only `running` lets it win (P2). */
  activity?: string | null;
  /** The stuck REASON or the finished RESULT, one plain sentence. */
  detail?: string | null;
  /** 0…1. Null/absent means "no honest number", which draws a moving track
   *  for a working helper and no track at all for anyone else. */
  progress?: number | null;
  /**
   * Whole minutes of silence, for the no-heartbeat state.
   *
   * NOT in the design doc's §4 sketch, and required by its own §3 table: the
   * state is spelled "Nothing heard for N min" and N has to arrive from
   * somewhere. Stated here rather than computed, because computing it would
   * mean reading a clock inside a fold that is deliberately clockless.
   */
  quietForMinutes?: number | null;
  /**
   * The one next move. Design P5 requires this whenever the state is stuck or
   * needs-you; a helper that arrives without one is a defect the components
   * surface rather than hide (see `actionGap`).
   */
  action?: { label: string; intent?: string } | null;
}

export interface CrewView {
  /** What the crew is on, in the human's words: "Fixing the contact form".
   *  Absent is fine — the header then leads with the count. */
  headline?: string | null;
  helpers: readonly HelperView[];
  /**
   * When the work was handed off. Formatted through `kit/time.ts` and nowhere
   * else — this package has exactly one date formatter, and a second one is
   * how "4m ago" and "4 minutes ago" end up on the same screen.
   */
  startedAt?: string | number | Date | null;
  /**
   * The host's clock reading. Passed IN rather than read here so the fold
   * stays pure: a module that called `Date.now()` would make every test
   * time-dependent and every render non-deterministic.
   */
  now?: number;
  /** "about 6 min left". An estimate the host may not have; absent omits the
   *  line entirely rather than guessing (design §4). */
  estimate?: string | null;
}

/** How a row draws its progress track. */
export type CrewTrack = 'determinate' | 'indeterminate' | 'none';

export interface CrewRow {
  key: string;
  role: string;
  /** Two letters for the avatar, derived from the ROLE — never from the id. */
  monogram: string;
  words: HelperWords;
  /** Clamped to 0…1, or null when the host gave no honest number. */
  progress: number | null;
  track: CrewTrack;
  action: { label: string; intent?: string } | null;
  /**
   * True when P5 is owed an action and none arrived. The row still renders —
   * swallowing it would hide the only states a person must act on — and falls
   * back to a generic affordance rather than to nothing.
   */
  actionGap: boolean;
}

export interface CrewCounts {
  facet: CrewFacet;
  count: number;
}

export interface CrewSummary {
  rows: readonly CrewRow[];
  /** Per-facet counts, summary order, zeroes dropped. */
  counts: readonly CrewCounts[];
  /** "1 needs you · 1 working · 1 waiting". Empty for an empty crew. */
  summaryLine: string;
  /** How many helpers are still the crew's business. */
  outstanding: number;
  /** How many are asking for a person right now. Drives the one state that
   *  is allowed to be visually urgent. */
  needsYou: number;
  /** True when nothing is outstanding — the dock's "All done" condition. */
  allSettled: boolean;
  /** The header/strip pill: one tone and one short phrase for the whole crew. */
  headline: { tone: HelperTone; text: string };
  /** "Started 4m ago", or null when the host named no start. */
  startedLabel: string | null;
  /** "4m so far" — the dock's terser form of the same fact. */
  elapsedShort: string | null;
  /** The single line a settled crew collapses to. Null while anything is
   *  outstanding, so a caller cannot render it early by mistake. */
  allDoneLine: string | null;
}

/**
 * ~6 rows, then collapse. The prototype's own trade-off note ("with 10+
 * helpers the card gets tall") names this as the fix, and six is where a card
 * stops being a glance and starts being a list.
 */
export const CREW_VISIBLE_ROWS = 6;

function clampProgress(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/**
 * Two letters from the role. Two words give one letter each ("Live Checker" →
 * "LC"); one word gives its first two ("Drafter" → "DR"). Derived from the
 * role rather than the id so the monogram survives a re-spawn — and so the
 * only string near the avatar is one a person could have written.
 */
export function monogramOf(role: string): string {
  const words = role.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0].charAt(0)}${words[1].charAt(0)}`.toUpperCase();
}

function trackOf(progress: number | null, words: HelperWords): CrewTrack {
  if (progress !== null) return 'determinate';
  /* A moving track under a working helper says "something is happening" and
     claims no amount. Under any other tone it would claim motion that has
     stopped. */
  return words.tone === 'working' ? 'indeterminate' : 'none';
}

export function crewRowOf(helper: HelperView): CrewRow {
  const words = helperWordsOf(helper.state, {
    quietForMinutes: helper.quietForMinutes ?? null,
    activity: helper.activity ?? null,
    detail: helper.detail ?? null,
  });
  const progress = clampProgress(helper.progress);
  const action = helper.action ?? null;
  return {
    key: helper.key,
    role: helper.role,
    monogram: monogramOf(helper.role),
    words,
    progress,
    track: trackOf(progress, words),
    action,
    actionGap: (words.tone === 'stuck' || words.tone === 'needs-you') && action === null,
  };
}

function joinSummary(counts: readonly CrewCounts[]): string {
  return counts.map((entry) => `${entry.count} ${facetWord(entry.facet)}`).join(' · ');
}

/* THE TWO TIME PHRASES, both delegated. `relTime` carries its own direction
   ("4m ago"); `elapsed` is a bare magnitude and the caller supplies the
   preposition — which is why the strip reads "4m so far" rather than
   re-deriving the same number in different words. */

function startedLabelOf(view: CrewView): string | null {
  const at = view.startedAt;
  if (at === null || at === undefined) return null;
  const said = relTime(at, view.now ?? Date.now());
  return said ? `Started ${said}` : null;
}

function elapsedShortOf(view: CrewView): string | null {
  const at = view.startedAt;
  if (at === null || at === undefined) return null;
  const said = elapsed(at, view.now ?? Date.now());
  return said ? `${said} so far` : null;
}

/**
 * THE HEADER PILL — the crew in one tone and one phrase, most urgent fact
 * first. This is the ladder the whole design rests on: a person who reads
 * only this must never be told "2 working" while one helper is asking them a
 * question.
 */
function headlineOf(counts: readonly CrewCounts[], outstanding: number): { tone: HelperTone; text: string } {
  const at = (facet: CrewFacet): number => counts.find((entry) => entry.facet === facet)?.count ?? 0;
  const needsYou = at('needs-you');
  if (needsYou > 0) return { tone: 'needs-you', text: `${needsYou} needs you` };
  const stuck = at('stuck');
  if (stuck > 0) return { tone: 'stuck', text: `${stuck} stuck` };
  const working = at('working');
  if (working > 0) return { tone: 'working', text: `${working} working` };
  if (outstanding > 0) return { tone: 'idle', text: `${outstanding} waiting` };
  return { tone: 'done', text: 'All done' };
}

/**
 * The settled crew's one line. It reports what actually happened rather than
 * assuming everything finished — a crew of two where one was stopped is not
 * "2 helpers finished", and a strip that said so would be the first place a
 * person learned to distrust it.
 */
function allDoneLineOf(counts: readonly CrewCounts[], outstanding: number, total: number): string | null {
  if (outstanding > 0 || total === 0) return null;
  const at = (facet: CrewFacet): number => counts.find((entry) => entry.facet === facet)?.count ?? 0;
  const finished = at('finished');
  const stopped = at('stopped');
  if (stopped === 0) return `All done — ${helperCountWords(finished)} finished.`;
  if (finished === 0) return `Nothing left — ${helperCountWords(stopped)} stopped.`;
  return `All done — ${finished} finished · ${stopped} stopped.`;
}

export function crewSummaryOf(view: CrewView): CrewSummary {
  const rows = view.helpers.map(crewRowOf);

  const tally = new Map<CrewFacet, number>();
  for (const row of rows) tally.set(row.words.facet, (tally.get(row.words.facet) ?? 0) + 1);
  const counts: CrewCounts[] = CREW_FACET_ORDER.filter((facet) => (tally.get(facet) ?? 0) > 0).map(
    (facet) => ({ facet, count: tally.get(facet) ?? 0 }),
  );

  const outstanding = rows.filter((row) => row.words.outstanding).length;
  const needsYou = rows.filter((row) => row.words.mayInterrupt).length;

  return {
    rows,
    counts,
    summaryLine: joinSummary(counts),
    outstanding,
    needsYou,
    allSettled: rows.length > 0 && outstanding === 0,
    headline: headlineOf(counts, outstanding),
    startedLabel: startedLabelOf(view),
    elapsedShort: elapsedShortOf(view),
    allDoneLine: allDoneLineOf(counts, outstanding, rows.length),
  };
}

export interface CrewCollapse {
  shown: readonly CrewRow[];
  hiddenCount: number;
  /** What is out of sight, in the same words the footer uses. Null when
   *  nothing is hidden. A collapse that only said "+4 more" would be the one
   *  place the card stopped telling the truth about its crew. */
  hiddenSummary: string | null;
}

/**
 * Collapse to `CREW_VISIBLE_ROWS`, and SAY WHAT IS HIDDEN.
 *
 * Ordering is the host's, untouched — a card that sorted urgent helpers to
 * the top would move rows under a reader's cursor every time a status
 * changed. Instead the hidden remainder is summarised, so an urgent helper
 * below the fold is still counted in a line the reader can see.
 */
export function collapseCrewRows(rows: readonly CrewRow[], expanded: boolean): CrewCollapse {
  if (expanded || rows.length <= CREW_VISIBLE_ROWS) {
    return { shown: rows, hiddenCount: 0, hiddenSummary: null };
  }
  const shown = rows.slice(0, CREW_VISIBLE_ROWS);
  const hidden = rows.slice(CREW_VISIBLE_ROWS);
  const tally = new Map<CrewFacet, number>();
  for (const row of hidden) tally.set(row.words.facet, (tally.get(row.words.facet) ?? 0) + 1);
  const counts: CrewCounts[] = CREW_FACET_ORDER.filter((facet) => (tally.get(facet) ?? 0) > 0).map(
    (facet) => ({ facet, count: tally.get(facet) ?? 0 }),
  );
  return { shown, hiddenCount: hidden.length, hiddenSummary: joinSummary(counts) };
}
