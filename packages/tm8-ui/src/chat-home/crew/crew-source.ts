/**
 * THE JOIN — real work sessions become `HelperView`s.
 *
 * PR #509 shipped the Crew Card and the Live Dock fixture-driven and said why:
 * *"The only producers of a `CrewView` that exist anywhere in the tree are the
 * fixtures in this diff."* This file is the first real one. Nothing about the
 * seam is redesigned — `HelperView` is taken exactly as `crew-model.ts`
 * declares it, and every field this fold cannot honestly fill is OMITTED so
 * the components render their documented absent-value behaviour instead of a
 * placeholder invented here.
 *
 * ## The three fields that stay empty, and on whose authority
 *
 * DESIGN 2 (#507) answered these, and the answers are load-bearing enough to
 * quote rather than paraphrase:
 *
 *  · `activity` — the honest per-session "what am I doing right now" line comes
 *    from the agent's own transcript (#507's `derived` tier). Nothing produces
 *    it yet. Omitted, so a `running` helper reads "Working on it" — which is
 *    P2's known cost until that tier ships, not a lie.
 *  · `progress` / `estimate` — #507: **"no, and there will not be one."** Three
 *    candidate sources, all rejected. Omitted permanently, not pending.
 *  · `quietForMinutes` — the no-heartbeat state's N. It needs `lastOutputAt`,
 *    which is not on any wire this client reads. Omitted, so the label falls
 *    back to the vocabulary's own "Nothing heard for a while" rather than to a
 *    fabricated number. That fallback is in `HELPER_WORDS.no_heartbeat` and is
 *    documented there as exactly this case.
 *
 * ## What this fold refuses to say
 *
 * `awaiting_input` is the ONLY state allowed to interrupt a person (P4), and
 * this fold never emits it. That is deliberate and it is `SpawnService`'s own
 * rule, from the docstring on the method that writes `idle`:
 *
 *     'idle' here means "this PTY has been silent for the host's quiescence
 *     threshold", nothing more. It is NOT proof an agent is waiting on a human
 *     — a silent `npm install` produces the same evidence — so no caller may
 *     render it as a specific question.
 *
 * A fold that mapped `idle` to "Needs a word from you" would badge, announce
 * and pull focus every time an agent paused to think. It maps to the quiet
 * state instead. When a real needs-input signal exists (#507's hook tier), this
 * is the one line that changes.
 *
 * Also never emitted: `queued`, `blocked` and `cancelled`. No source
 * distinguishes a session a person stopped from one that exited on its own —
 * `execution.terminate` and a clean finish both land on `exited` — and
 * inventing "You stopped this" for a session that finished by itself would be
 * a specific false statement about the reader's own actions.
 *
 * ## PURE, and clockless in the same way `crew-model.ts` is
 *
 * No React, no seam, no `Date.now()`. Everything arrives as an argument, so the
 * whole mapping is testable as a table.
 */
import type { EntityDetail, LivenessConfidence } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import type { CrewView, HelperView } from './crew-model';

/**
 * One session's read, as the fleet's own hook already models it. Reused rather
 * than redeclared so the crew and the fleet pane cannot disagree about what
 * "we asked and it failed" looks like.
 */
export type CrewEntityRead =
  | { state: 'pending' }
  | { state: 'loaded'; detail: EntityDetail }
  | { state: 'failed' };

export interface CrewSourceInput {
  /**
   * The sessions this conversation is responsible for, in the order it should
   * show them. Ordering is the CALLER'S — `collapseCrewRows` keeps host order
   * on purpose, and re-sorting here would move rows under a reader's cursor on
   * every status change, which is the thing that ordering note exists to stop.
   */
  readonly sessionIds: readonly string[];
  /** What `entities.get` came back with for each id, if anything yet. */
  readonly reads: ReadonlyMap<string, CrewEntityRead>;
  /** THE liveness predicate. Never inferred from a recorded status here. */
  readonly livenessOf: (session: { id: string; status: string | null }) => SessionLiveness;
  /**
   * DESIGN 2's evidence tier for this session, or null when the node has not
   * spoken about it and a periodic read is all we have. Optional so a caller
   * that has no seam (a storybook, a test) still gets a valid `CrewView`.
   */
  readonly confidenceOf?: (sessionId: string) => LivenessConfidence | null;
  /** What the crew is on, in the human's words. Absent leads with the count. */
  readonly headline?: string | null;
  /** When the hand-off happened. Formatted by `kit/time.ts`, never here. */
  readonly startedAt?: string | number | Date | null;
  /** The host's clock reading, passed in to keep the fold deterministic. */
  readonly now?: number;
}

/**
 * The states this fold can produce, as the presentation vocabulary spells
 * them. NOT re-exported as a type from `status-vocabulary.ts`: `HelperView.state`
 * is a `string` by design so an unrecognised value degrades through
 * `helperWordsOf` rather than failing to compile, and narrowing it here would
 * push that case back out to the caller.
 *
 * `'unknown'` is not one of the eight and is not meant to be. It is the token
 * that lands on `UNKNOWN_HELPER_WORDS` — "Checking on this one", idle tone,
 * outstanding, cannot interrupt — which is precisely the sentence a person
 * should read when liveness cannot be established. tm8 already spells this
 * state `unknown` everywhere else it appears, and #507 notes that it already
 * renders as "unverified": the vocabulary is not the gap, the routing is.
 */
const CANNOT_ESTABLISH = 'unknown';

/**
 * THE TABLE. Recorded status × liveness verdict → what a person is told.
 *
 * Read the `running` row first, because it is the one that used to lie. A row
 * that says `running` is a claim the DATABASE is making, and the database
 * cannot see a terminal. Only the live set can, so `running` alone never
 * produces "Working on it" — it produces it when the node also says the PTY is
 * there, and something quieter when the node says otherwise or says nothing.
 */
function helperStateOf(status: string | null, liveness: SessionLiveness): string {
  switch (status) {
    case 'spawning':
      /* Booting. There is nothing to be stale about yet — the PTY may not
         exist for another few hundred milliseconds — so the liveness verdict is
         deliberately not consulted. "Getting set up" is true either way. */
      return 'spawning';

    case 'running':
      if (liveness === 'live') return 'running';
      /* RECORDED RUNNING, NO LIVE TERMINAL. This is the ghost: the row was
         never transitioned because the exit path had no claims, or the node
         restarted. The evidence is strong that the agent is gone, and it is
         still not proof — so this says what it observed ("nothing heard")
         rather than what it concluded ("failed"). `outstanding: true` on that
         state keeps it in the crew's business, which is right: a ghost is
         someone's problem, not a finished job. */
      if (liveness === 'stale') return 'no_heartbeat';
      /* 'unknown' / 'not-running': no fresh snapshot at all. We are not
         entitled to either verdict. */
      return CANNOT_ESTABLISH;

    case 'idle':
      /* THE ONE MAPPING THIS FILE'S HEADER IS ABOUT. `idle` is a silence timer
         firing, not a question being asked. Quiet, outstanding, and it may not
         interrupt. See the header for why `awaiting_input` is wrong here. */
      if (liveness === 'live') return 'no_heartbeat';
      if (liveness === 'stale') return 'no_heartbeat';
      return CANNOT_ESTABLISH;

    case 'exited':
      return 'completed';

    case 'failed':
      return 'failed';

    default:
      /* A status this build does not know. Not an error and not a guess. */
      return CANNOT_ESTABLISH;
  }
}

/**
 * Anything that looks like it came out of a machine rather than out of a
 * person. P1 is "no machine language reaches the eye", and #509's own
 * self-critique named this as the hole its tests could not close:
 *
 *     `HelperView.key` is a plain `string`; nothing stops a future edit
 *     rendering it, and nothing stops a HOST from passing `role: "session
 *     01a028f6…"`, which would sail through every assertion here.
 *
 * This file is that host. The check is here, at the boundary where a server
 * string becomes a `role`, because that is the only place it can be enforced
 * rather than asserted.
 */
const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** `snake_case_token`, `kebab-case-tool`, `camelCaseIdentifier` — three words a
 *  person does not write in a sentence and a serialiser writes constantly. */
const IDENTIFIER_SHAPED = /(^|\s)[a-z0-9]+([_-][a-z0-9]+)+(\s|$)/i;
/** A bare hex or base32 blob of the length ids and shas come in. */
const OPAQUE_TOKEN = /(^|\s)[0-9a-f]{12,}(\s|$)/i;

/**
 * The neutral noun. Not a placeholder for a name we have — the absence of one.
 *
 * `role` is REQUIRED by `HelperView` and explicitly has no fallback to an id,
 * because "a fallback to an id is how ids reach screens". So the fallback has
 * to be a word, and it has to be one that claims nothing: "Helper" says what
 * the thing is and nothing about what it is for.
 */
const UNNAMED_ROLE = 'Helper';

/** How much of a title is a role rather than a paragraph. */
const MAX_ROLE_LENGTH = 48;

/**
 * A session title as a ROLE, or the neutral noun when it is not fit to be one.
 *
 * Exported for the test that enumerates the refusals — this is the P1 boundary
 * and it deserves to be examined directly rather than only through a render.
 */
export function roleFromTitle(title: string | null | undefined): string {
  const trimmed = (title ?? '').trim();
  if (trimmed === '') return UNNAMED_ROLE;
  if (UUID_SHAPED.test(trimmed)) return UNNAMED_ROLE;
  if (OPAQUE_TOKEN.test(trimmed)) return UNNAMED_ROLE;
  if (IDENTIFIER_SHAPED.test(trimmed)) return UNNAMED_ROLE;
  if (trimmed.length <= MAX_ROLE_LENGTH) return trimmed;
  /* Cut on a word boundary and end on a character, not an ellipsis pretending
     to be one. A role that ends mid-word reads as corrupt. */
  const cut = trimmed.slice(0, MAX_ROLE_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_ROLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** The `work_session` facts this fold needs, or null for anything else. */
function sessionFactsOf(detail: EntityDetail): { status: string | null } | null {
  const state = detail.state as { kind?: string; status?: unknown } | undefined;
  if (state?.kind !== 'work_session') return null;
  return { status: typeof state.status === 'string' ? state.status : null };
}

export interface CrewFold {
  view: CrewView;
  /**
   * Sessions that are owed a next move and did not get one — `crew-model.ts`
   * computes `actionGap` per row and #509's self-critique flagged that
   * **nothing ever shows it to anyone**: *"The UI quietly papers over a host
   * that broke the rule."*
   *
   * This is the host. It cannot supply the actions (no verb for "look into a
   * stuck session" is defined anywhere yet), so it reports the debt in its own
   * return value instead of leaving the components to paper over it silently. A
   * caller that ignores this gets the card's generic "Look into it" fallback,
   * which is the documented behaviour — it just no longer happens invisibly.
   */
  actionGaps: readonly string[];
  /**
   * Sessions whose state rests on NO push at all — the node has said nothing
   * about them and the verdict comes from a periodic read up to 90 seconds old.
   *
   * This is #507's rule made available rather than merely respected: a surface
   * that wants to mark these "unverified" now can. It is reported rather than
   * folded into the state because the two are different questions — WHAT is
   * happening, and HOW WELL WE KNOW — and collapsing them is the defect #507
   * was written about.
   */
  unverified: readonly string[];
}

/**
 * Fold real sessions into the view model the Crew Card and the Live Dock take.
 *
 * A session that has not loaded yet, or whose read failed, or that turned out
 * not to be a work_session, is DROPPED rather than rendered as an unknown
 * helper. Those are facts about this client's reading, not about a crew, and a
 * row that appears and then vanishes when a 404 settles is worse than one that
 * arrives a moment late. `foldFleet` already renders unreadable ids honestly in
 * the pane beside this one, which is where that belongs.
 */
export function crewViewFrom(input: CrewSourceInput): CrewFold {
  const helpers: HelperView[] = [];
  const actionGaps: string[] = [];
  const unverified: string[] = [];

  for (const id of input.sessionIds) {
    const read = input.reads.get(id);
    if (read === undefined || read.state !== 'loaded') continue;
    const facts = sessionFactsOf(read.detail);
    if (facts === null) continue;

    const liveness = input.livenessOf({ id, status: facts.status });
    const state = helperStateOf(facts.status, liveness);

    /* NOTE WHAT IS NOT SPREAD IN. `activity`, `progress`, `estimate` and
       `quietForMinutes` are absent, not null-and-absent-later: `HelperView`
       treats an omitted optional and an explicit null identically, and writing
       `activity: null` would suggest a source exists and returned nothing.
       None exists. See the header. */
    helpers.push({ key: id, role: roleFromTitle(read.detail.title), state });

    /* P5's debt, recorded at the only layer that can see both the state and the
       absence of an action for it. `failed` is the only stuck-toned state this
       fold emits. */
    if (state === 'failed') actionGaps.push(id);

    /* Provenance. Null means the node has told us nothing about this session
       and the verdict above rests on a poll. */
    if (input.confidenceOf?.(id) == null) unverified.push(id);
  }

  return {
    view: {
      helpers,
      ...(input.headline == null ? {} : { headline: input.headline }),
      ...(input.startedAt == null ? {} : { startedAt: input.startedAt }),
      ...(input.now === undefined ? {} : { now: input.now }),
      /* `estimate` is never set. #507: there will not be one. */
    },
    actionGaps,
    unverified,
  };
}
