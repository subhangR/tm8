/**
 * HOME MODEL — the pure composition behind T5-1's two columns.
 *
 * No React, no seam, no DOM: given the rows the app has read, the seam's
 * liveness VERDICTS and the inbox page, this produces the sections the screen
 * draws. Everything here is a projection of facts that already exist; nothing
 * is derived that the seam is the authority for.
 *
 * THREE LAWS THIS FILE EXISTS TO KEEP (each one is load-bearing):
 *
 *  1. **The verdict outranks the record (D39/D6/R-UI-5).** A session's word and
 *     tone come from the registry's `liveTreatment(verdict)` where one exists,
 *     never from `state.status`. This file never computes a verdict — it is
 *     handed `livenessOf` and asks it.
 *  2. **No kind literal (§15.2).** Which kinds are "session-shaped" and which
 *     can carry assignees is answered by REGISTRY CAPABILITY (`list.liveTreatment`
 *     exists / `tile.badges` names `assignees`), not by naming a kind. Adding a
 *     kind that gains a liveTreatment makes it appear here with no edit, which
 *     is the whole point of the rule.
 *  3. **The oracle's triage ORDER is the law that survives the 320 floor**
 *     (T5-1 frame 3 annotation "Floor"): NEEDS YOU → live → tasks → mentions.
 *     The order lives in `composeMyWork`'s return, once, so the wide layout and
 *     the stacked floor cannot drift apart.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not send, or ask for, the contract's
 * `needsActorId` / `inFlightForActorId` preset filters. They are declared
 * (contract.ts §2.1) and the real seam passes filters through verbatim, but the
 * FIXTURE seam's `query()` matches only `status`/`sessionStatus`/
 * `assigneeIds`/`deleted` and IGNORES every other key silently — so a
 * `needsActorId` query returns the UNFILTERED set, and labelling that "NEEDS
 * YOU" would be a fabricated count on the loudest row of the screen. Home
 * composes the same meaning from facts BOTH implementations honour. See
 * HANDOVER.md GAPS.
 */
import type { ActorSummary, EntitySummary, NotificationItem } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import { allKinds, getKind } from '../domain';
import type { KindConfig, StatusSource } from '../domain/types';
import type { PillTone } from '../kit';

// ---------------------------------------------------------------------------
// Registry capability queries — how Home decides WHICH kinds it reads
// ---------------------------------------------------------------------------

/**
 * Kinds whose rows carry a liveness VERDICT. Today that is exactly one kind;
 * the point is that this file never says which. A kind is "live-shaped" iff the
 * registry gave it a `liveTreatment`, because that field IS the statement that
 * the seam's verdict governs its presentation.
 */
export function liveKinds(): KindConfig[] {
  return allKinds().filter((row) => row.list.liveTreatment !== undefined);
}

/**
 * Kinds whose rows can be assigned to somebody — the ones a `assigneeIds`
 * filter can possibly match. Derived from the registry's own tile-badge
 * sources, so it tracks the registry rather than a second hand-kept list.
 */
export function assignableKinds(): KindConfig[] {
  return allKinds().filter((row) => row.list.tile.badges.some((b) => b.source === 'assignees'));
}

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
  /**
   * The row's KIND — the screen draws its registry mark. Null only where the
   * row stands for something with no entity behind it (a notification whose
   * target the seam did not carry), and then the screen draws nothing rather
   * than inventing a mark for a thing it cannot name.
   */
  kind: string | null;
  title: string;
  /** Status WORD. Status is always colour + word, never colour alone (C8/L10). */
  word: string | null;
  tone: PillTone;
  dot: HomeDot;
  /** Present only when this row explicitly names an actor (inbox notices). */
  actor?: ActorSummary;
  /**
   * The long-form honest sentence for the degraded verdicts, carried on
   * `title=` so the short word never loses its explanation (D34).
   */
  detail?: string;
  /**
   * WHEN IT LAST DID SOMETHING. The summary's own `activityAt`, passed through
   * unrounded — the screen decides how to say it, this decides nothing.
   *
   * Owner, 2026-08-30: "a card with its progress and activity". This is the
   * activity half and it is the honest one: the node stamps it, we do not
   * derive it.
   */
  activityAt?: string;
  /**
   * HOW MUCH HAS HAPPENED — the summary's `messages` counter, which for a
   * session is its turns.
   *
   * THIS IS NOT A PERCENTAGE AND THERE IS NO BAR. A session has no total to
   * divide by; a progress bar would need a denominator nothing on the wire
   * carries, so drawing one means inventing it. A number that only goes up is
   * the true shape of the fact, and "12 turns" is progress a reader can act on
   * in a way "60%" of an unknown whole is not.
   */
  turns?: number;
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
/**
 * THE TWO FACTS A RUNNING CARD SHOWS, taken from the summary and not derived.
 *
 * `activityAt` is the node's own stamp. `turns` is the `messages` counter,
 * which for a session is how many turns it has taken.
 *
 * BOTH ARE OMITTED WHEN ABSENT rather than defaulted to 0 or "never". A card
 * that draws "0 turns" on a session whose counter has not arrived states
 * something false about the session; a card that draws nothing states nothing.
 * The same rule the strips follow — absence is not a claim.
 */
function factsOf(summary: EntitySummary): Pick<HomeRow, 'activityAt' | 'turns'> {
  const turns = summary.counters?.messages;
  return {
    ...(summary.activityAt ? { activityAt: summary.activityAt } : {}),
    ...(typeof turns === 'number' && turns > 0 ? { turns } : {}),
  };
}

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
      ...factsOf(summary),
    };
  }

  const spec = config.panel.statusPill;
  const source: StatusSource = spec?.source ?? 'none';
  const value = statusValueOf(source, summary.state);
  if (!spec || value === null) {
    return {
      id: summary.id,
      kind,
      title: summary.title,
      word: null,
      tone: 'idle',
      dot: null,
      ...factsOf(summary),
    };
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
    ...factsOf(summary),
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface HomeSection {
  id: string;
  /** Uppercase eyebrow copy WITHOUT the count — the renderer appends it. */
  label: string;
  rows: readonly HomeRow[];
  /** Amber only for NEEDS YOU (T5-1 annotation 3: "pinned first in wait amber"). */
  emphasis: 'needs-you' | null;
  /**
   * What to say when `rows` is empty. NEVER absent: a section that renders
   * nothing and says nothing is the silent void this whole screen is graded on.
   * When a section is empty because a READ could not run, this carries that
   * fact rather than an "all clear".
   */
  emptyNote: string;
}

export interface ComposeInput {
  /** Rows for the live-shaped kinds, unfiltered. */
  sessionPool: readonly EntitySummary[];
  /** Rows the seam returned for `assigneeIds: [me]`. */
  myTasks: readonly EntitySummary[];
  /** Rows the seam returned for `assigneeIds: [me]` + the review status. */
  myReview: readonly EntitySummary[];
  /** THE verdict function. Never re-derived here. */
  livenessOf: (id: string) => SessionLiveness;
  /** Pool byte-activity, keyed by id (§9.2). */
  activity: Readonly<Record<string, boolean>>;
  /**
   * The inbox page, or `null` when the read has not resolved / rejected.
   * `[]` and `null` are DIFFERENT facts and the section says which.
   */
  notifications: readonly NotificationItem[] | null;
  /** Set when the inbox read rejected, so the section states the failure. */
  notificationsError?: string | null;
  /**
   * False while `identity()` has not resolved. "We have not asked who you are
   * yet" and "nothing is assigned to you" are different facts, and an empty
   * MY TASKS that says the second while the first is true is a confident zero
   * — the failure shape D6 forbids one layer up.
   */
  viewerKnown: boolean;
  /** Set when `identity()` rejected, so the sections state the failure. */
  viewerError?: string | null;
  compact?: boolean;
}

export interface MyWork {
  sections: readonly HomeSection[];
  /** `● N live` — from the LIVE SET only, never from a record field. */
  liveCount: number;
  /** The label is registry data (`list.liveCount.label`), not a format string here. */
  liveCountLabel: string;
}

/** Verdicts that mean "this session is part of my current work". */
const ONGOING: readonly SessionLiveness[] = ['live', 'stale', 'unknown'];

/**
 * THE TRIAGE ORDER, once. Frame 1 draws it and frame 3 rules that it is what
 * survives the floor, so both layouts consume this same array.
 */
export function composeMyWork(input: ComposeInput): MyWork {
  const { livenessOf, activity, compact } = input;

  const verdictOf = (row: EntitySummary): SessionLiveness | undefined =>
    getKind(row.kind).list.liveTreatment ? livenessOf(row.id) : undefined;

  const sessionRow = (row: EntitySummary): HomeRow =>
    homeRowOf(row, {
      liveness: verdictOf(row),
      streaming: activity[row.id] === true,
      compact,
    });

  // -- NEEDS YOU -----------------------------------------------------------
  // Two honest sources, both already authoritative elsewhere:
  //   (a) the REGISTRY's own `needsAttentionGroup` predicate, evaluated against
  //       the seam verdict — for sessions that is "live but the agent went
  //       idle", i.e. it is waiting on you. This is the oracle's "scout —
  //       waiting on your approval" row, and it is registry data, not a rule
  //       invented here.
  //   (b) tasks assigned to me sitting in the review status — the seam
  //       executed that filter, so the membership is the node's answer.
  const needsSessions = input.sessionPool.filter((row) => {
    const config = getKind(row.kind);
    const predicate = config.list.needsAttentionGroup;
    if (!predicate) return false;
    const verdict = verdictOf(row);
    if (verdict === undefined) return false;
    // `ListRowFacts` is deliberately narrow — a predicate that wants more is
    // asking to derive something the seam owns. `status` is the row's own
    // recorded scalar, which is exactly what the predicate pairs against the
    // verdict; it never stands in for one.
    return predicate(
      {
        id: row.id,
        kind: row.kind,
        activityAt: row.activityAt,
        status: statusValueOf(config.chip.tintBy, row.state),
        blockedCount: row.badges.blocked?.unresolvedHardDependencyCount ?? 0,
      },
      verdict,
    );
  });

  const needsYou: HomeRow[] = [
    ...needsSessions.map(sessionRow),
    ...input.myReview.map((row) => homeRowOf(row, { compact })),
  ];

  // -- MY LIVE SESSIONS ----------------------------------------------------
  // Membership is the VERDICT, never the record: a session whose record says
  // running while the node has no PTY for it is `stale`, and it belongs here
  // wearing that word (the oracle draws exactly that row, "probe — stale, node
  // restarted"). A `not-running` session is finished work, not current work.
  const live = input.sessionPool
    .filter((row) => {
      const verdict = verdictOf(row);
      return verdict !== undefined && ONGOING.includes(verdict);
    })
    .map(sessionRow);

  // -- MY TASKS ------------------------------------------------------------
  // Annotation 4: this is a FILTER (assignee = me), not a copy — the rows are
  // the same entities and open the same Z3 panel. Rows already surfaced above
  // are not repeated; one fact, one place on the screen.
  const shownAbove = new Set(needsYou.map((r) => r.id));
  const tasks = input.myTasks
    .filter((row) => !shownAbove.has(row.id))
    .map((row) => homeRowOf(row, { compact }));

  const liveCount = live.filter((row) => row.dot === 'pulse' || row.dot === 'solid').length;
  const liveLabelFn = liveKinds()[0]?.list.liveCount?.label;

  const viewerNote = input.viewerError
    ? `Your identity could not be read from this node — ${input.viewerError}`
    : !input.viewerKnown
      ? 'Reading who you are on this node…'
      : null;

  return {
    liveCount,
    liveCountLabel: liveLabelFn ? liveLabelFn(liveCount) : `${liveCount} live`,
    sections: [
      {
        id: 'needs-you',
        label: 'NEEDS YOU',
        rows: needsYou,
        emphasis: 'needs-you',
        emptyNote: viewerNote ?? 'Nothing is waiting on you.',
      },
      {
        id: 'live',
        label: 'MY LIVE SESSIONS',
        rows: live,
        emphasis: null,
        emptyNote: 'No sessions are running — launch one from a task.',
      },
      {
        id: 'tasks',
        label: 'MY TASKS',
        rows: tasks,
        emphasis: null,
        emptyNote:
          viewerNote ?? 'Nothing pulled yet — no task in this space lists you as an assignee.',
      },
      {
        id: 'mentions',
        label: 'MENTIONS & ASSIGNMENTS',
        rows: notificationRows(input.notifications),
        emphasis: null,
        emptyNote: mentionsEmptyNote(input.notifications, input.notificationsError ?? null),
      },
    ],
  };
}

/**
 * The two loudest inbox classes, surfaced (annotation 5); the full read-state
 * model stays in Inbox. A notification with no target still renders — dropping
 * it would hide a fact the node sent us.
 */
export function notificationRows(items: readonly NotificationItem[] | null): HomeRow[] {
  if (!items) return [];
  return items
    .filter((n) => n.readAt === null)
    .map((n) => {
      const target = n.target ?? null;
      const kind = target?.kind ?? null;
      const actor = n.actor?.displayName ?? 'someone';
      const verb = n.kind.replace(/_/g, ' ');
      return {
        id: n.id,
        kind,
        title: n.message ?? `${actor} — ${verb}${target ? ` · ${target.title}` : ''}`,
        word: verb,
        tone: (n.kind === 'review_request' ? 'wait' : 'info') as PillTone,
        dot: null as HomeDot,
        ...(n.actor ? { actor: n.actor } : {}),
      };
    });
}

/**
 * WHY the mentions section is empty, stated. Three different facts wear three
 * different sentences: the read has not run, the read failed, or the node
 * genuinely has nothing. Collapsing them into one "no mentions" would be the
 * facet collapse D6 forbids at every other consumer.
 */
export function mentionsEmptyNote(
  items: readonly NotificationItem[] | null,
  error: string | null,
): string {
  if (error) return `Mentions could not be read from this node — ${error}`;
  if (!items) return 'Reading your mentions…';
  if (items.length > 0) return '';
  return 'No unread mentions or assignments on this node.';
}
