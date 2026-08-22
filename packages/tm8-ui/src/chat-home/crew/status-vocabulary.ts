/**
 * THE WORDS — one place that decides what a person reads about a helper.
 *
 * Section 0 of the "Agent Activity in Chat" prototypes (artifact
 * 01a028f6-5b26-77d6-bf6d-22cdca62a60b) is the contract this file implements,
 * and its rule is the whole reason the file exists: THE PERSON READING NEVER
 * SEES THE MACHINE WORD, ONLY THE HUMAN ONE. A surface that formats a status
 * inline is a surface where `awaiting_input` eventually reaches a screen, so
 * neither the Crew Card nor the Live Dock is allowed to know a status token —
 * they ask here and render what comes back.
 *
 * THIS IS THE PRESENTATION VOCABULARY, NOT THE WIRE ONE. `WorkSessionStatus`
 * in @tm8/contract is five values (`spawning | running | idle | exited |
 * failed`); the eight states below are what a NON-DEVELOPER needs told apart,
 * which is a different and larger set — "waiting its turn" and "nothing heard
 * for 5 min" are both `idle` on the wire and are opposite news to a person.
 * Mapping real session facts onto these eight is deliberately NOT done here:
 * that is the activity-signal design (task 01a028e1, DESIGN 2), and until it
 * lands these components are driven by fixtures. Guessing the mapping early
 * would bake in the exact lie this vocabulary exists to prevent.
 *
 * FOUR RULES THE TABLE ENCODES:
 *  · Only `awaiting_input` may interrupt. Everything else updates quietly.
 *  · `running` yields to a live activity line — "Reading your files…" beats
 *    "Working on it", and the prototype says so explicitly. Nothing else
 *    yields, because an activity line under a FINISHED helper would be a
 *    stale sentence presented as news.
 *  · Stuck is never bare. `blocked` and `failed` share one word ("Hit a
 *    wall") and the row that renders them must carry a sentence and an
 *    action — enforced by the components, stated here.
 *  · An unknown status resolves to a word that claims nothing (see
 *    `UNKNOWN_HELPER_WORDS`). A default of "Working" would invent progress
 *    and a default of "Hit a wall" would invent a failure.
 */
import type { PillTone } from '../../kit';

/**
 * The five things a helper's state can MEAN to the person reading. Tone is
 * what the card sorts, counts and colours by — never the status itself, so a
 * ninth status can arrive without touching a layout.
 */
export type HelperTone = 'working' | 'needs-you' | 'done' | 'stuck' | 'idle';

/**
 * The bucket a helper falls into in a SUMMARY LINE ("1 needs you · 1 working
 * · 1 waiting"). Deliberately finer than tone, because tone answers "how
 * alarmed should this look" and a facet answers "what word do I count it
 * under", and those diverge in three places that matter:
 *
 *  · `queued`, `cancelled`, `no_heartbeat` and an unknown status are all
 *    `idle` in tone and are four different pieces of news. Counting them
 *    together would produce "4 waiting" about a crew where one is stopped
 *    and one has gone silent.
 *  · `spawning` and `running` are both `working`, and nobody needs the
 *    difference in a count.
 *
 * A facet is also what `outstanding` is decided against below.
 */
export type CrewFacet =
  | 'needs-you'
  | 'stuck'
  | 'working'
  | 'waiting'
  | 'quiet'
  | 'checking'
  | 'finished'
  | 'stopped';

/**
 * The word each facet contributes to a summary line, and the ORDER the line
 * puts them in: what needs a person first, what is merely in flight after,
 * what is over last. A crew's most urgent fact must not be third.
 */
const FACET_WORD: readonly { facet: CrewFacet; word: string }[] = [
  { facet: 'needs-you', word: 'needs you' },
  { facet: 'stuck', word: 'stuck' },
  { facet: 'working', word: 'working' },
  { facet: 'waiting', word: 'waiting' },
  { facet: 'quiet', word: 'quiet' },
  { facet: 'checking', word: 'being checked' },
  { facet: 'finished', word: 'finished' },
  { facet: 'stopped', word: 'stopped' },
];

export const CREW_FACET_ORDER: readonly CrewFacet[] = FACET_WORD.map((entry) => entry.facet);

export function facetWord(facet: CrewFacet): string {
  return FACET_WORD.find((entry) => entry.facet === facet)?.word ?? facet;
}

/**
 * The eight states of section 0. `blocked` and `failed` are separate tokens
 * that deliberately share one presentation: the difference between them is a
 * distinction for an operator, and the person reading is told the same true
 * thing either way.
 */
export type HelperStatus =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'awaiting_input'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'no_heartbeat';

export interface HelperWords {
  /** The sentence. What the helper's line says it is doing. */
  label: string;
  /** The chip. Two words at most — it sits beside the sentence, not instead
   *  of it, so it may be terse where `label` may not. */
  pill: string;
  tone: HelperTone;
  /** Which word this helper is counted under in a summary line. */
  facet: CrewFacet;
  /**
   * True while this helper is still the crew's business.
   *
   * NOT derivable from tone, which is why it is stated per state. `stuck` is
   * outstanding (it is waiting on a person, not over), `cancelled` is not
   * (nothing more will happen), and `queued` and `cancelled` share a tone
   * while sitting on opposite sides of this line. The Live Dock's "All done"
   * collapse is exactly `every helper is not outstanding`, so getting this
   * wrong hides live work behind a finished-looking strip.
   */
  outstanding: boolean;
  /** True for `awaiting_input` and nothing else. A surface may badge, nudge
   *  or scroll for this; for every other state it must update in place. */
  mayInterrupt: boolean;
  /** True only for `running`. See the header note on stale sentences. */
  activityOverridesLabel: boolean;
}

/**
 * TONE → THE KIT'S PILL. This package's status ramp is the authority, NOT the
 * prototype's palette: `--pn-run` is the green that means live everywhere in
 * tm8, and the mockup's blue-for-working / green-for-done would have put two
 * meanings on one colour across the app. The prototype is a visual reference,
 * and this is the line where it yields to the design system.
 */
const PILL_TONE: Readonly<Record<HelperTone, PillTone>> = {
  working: 'run',
  'needs-you': 'wait',
  stuck: 'block',
  done: 'info',
  idle: 'idle',
};

export function pillToneOf(tone: HelperTone): PillTone {
  return PILL_TONE[tone];
}

/**
 * The eight states, in the order a person meets them. The strings are quoted
 * from section 0 and are not paraphrasable here — a surface that wants
 * different words changes THIS table, which is a decision with one diff.
 */
export const HELPER_WORDS: Readonly<Record<HelperStatus, HelperWords>> = {
  queued: {
    label: 'Waiting its turn',
    pill: 'Waiting',
    tone: 'idle',
    facet: 'waiting',
    outstanding: true,
    mayInterrupt: false,
    activityOverridesLabel: false,
  },
  spawning: {
    label: 'Getting set up',
    pill: 'Starting',
    tone: 'working',
    facet: 'working',
    outstanding: true,
    mayInterrupt: false,
    activityOverridesLabel: false,
  },
  running: {
    label: 'Working on it',
    pill: 'Working',
    tone: 'working',
    facet: 'working',
    outstanding: true,
    mayInterrupt: false,
    /* The one state whose sentence a live activity line may replace. */
    activityOverridesLabel: true,
  },
  awaiting_input: {
    label: 'Needs a word from you',
    pill: 'Your turn',
    tone: 'needs-you',
    facet: 'needs-you',
    outstanding: true,
    /* THE ONLY TRUE IN THIS COLUMN. */
    mayInterrupt: true,
    activityOverridesLabel: false,
  },
  blocked: {
    label: 'Hit a wall',
    pill: 'Stuck',
    tone: 'stuck',
    facet: 'stuck',
    /* Stuck is not over: it is waiting on a person. */
    outstanding: true,
    mayInterrupt: false,
    activityOverridesLabel: false,
  },
  failed: {
    label: 'Hit a wall',
    pill: 'Stuck',
    tone: 'stuck',
    facet: 'stuck',
    outstanding: true,
    mayInterrupt: false,
    activityOverridesLabel: false,
  },
  completed: {
    label: 'Finished',
    pill: 'Finished',
    tone: 'done',
    facet: 'finished',
    outstanding: false,
    mayInterrupt: false,
    activityOverridesLabel: false,
  },
  cancelled: {
    /* Attributed to the person on purpose, so it never reads as a failure. */
    label: 'You stopped this',
    pill: 'Stopped',
    tone: 'idle',
    facet: 'stopped',
    outstanding: false,
    mayInterrupt: false,
    activityOverridesLabel: false,
  },
  no_heartbeat: {
    /* The minute count is substituted by `helperWordsOf`; this is what the
       state says when nobody told us how long the silence has been. */
    label: 'Nothing heard for a while',
    pill: 'Quiet',
    tone: 'idle',
    facet: 'quiet',
    /* Silence is not an ending. Something may still be happening and we
       cannot see it, so it stays the crew's business. */
    outstanding: true,
    mayInterrupt: false,
    activityOverridesLabel: false,
  },
};

/**
 * THE FALLBACK, and why it reads like this. An unrecognised status is a fact
 * about OUR knowledge, not about the helper — so the sentence describes our
 * side ("Checking on this one") rather than claiming anything about its work.
 * It is `idle` so it cannot be counted as working, and it cannot interrupt.
 */
export const UNKNOWN_HELPER_WORDS: HelperWords = {
  label: 'Checking on this one',
  pill: 'Checking',
  tone: 'idle',
  facet: 'checking',
  outstanding: true,
  mayInterrupt: false,
  activityOverridesLabel: false,
};

export interface HelperWordsInput {
  /** Whole minutes of silence, for `no_heartbeat`. Ignored by every other
   *  state — a minute count on a finished helper is noise. */
  quietForMinutes?: number | null;
  /** The live line, when the signal has one. Applied only where the state
   *  says it may be (`running`). */
  activity?: string | null;
  /**
   * The stuck REASON or the finished RESULT, in one plain sentence.
   *
   * Design §3: a state word alone is not the display. "Finished" ends on the
   * result ("Finished — 4 files changed") and "Hit a wall" ends on the cause,
   * because a person cannot act on either word by itself. A stuck helper with
   * no detail gets an explicit admission rather than a bare two-word label —
   * P7, and the same refusal as the no-heartbeat state.
   */
  detail?: string | null;
}

/** The states whose label ends on a detail sentence rather than on a word. */
const DETAIL_JOINS: ReadonlySet<HelperStatus> = new Set<HelperStatus>([
  'completed',
  'blocked',
  'failed',
]);

function isHelperStatus(status: string): status is HelperStatus {
  return Object.prototype.hasOwnProperty.call(HELPER_WORDS, status);
}

/**
 * The one entry point. Takes a `string` rather than `HelperStatus` on
 * purpose: the caller is ultimately a server field, and a function that only
 * accepted the known union would push the unknown case out to every call
 * site, where it would be handled differently in each.
 */
export function helperWordsOf(status: string, input: HelperWordsInput = {}): HelperWords {
  if (!isHelperStatus(status)) return UNKNOWN_HELPER_WORDS;
  const base = HELPER_WORDS[status];

  if (status === 'no_heartbeat') {
    const minutes = input.quietForMinutes;
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
      return { ...base, label: `Nothing heard for ${Math.round(minutes)} min` };
    }
    return base;
  }

  const activity = input.activity?.trim();
  if (base.activityOverridesLabel && activity) return { ...base, label: activity };

  if (DETAIL_JOINS.has(status)) {
    const detail = input.detail?.trim();
    if (detail) return { ...base, label: `${base.label} — ${detail}` };
    /* P5/P7: "Hit a wall" with nothing after it tells a person nothing and
       looks identical to a healthy two-word label. Say what we do not know. */
    if (base.tone === 'stuck') {
      return { ...base, label: `${base.label} — no reason came back with this one` };
    }
  }

  return base;
}

/** The plural noun a count of helpers takes. Here rather than in two
 *  components, so the card and the dock cannot disagree about it. */
export function helperCountWords(count: number): string {
  return `${count} ${count === 1 ? 'helper' : 'helpers'}`;
}
