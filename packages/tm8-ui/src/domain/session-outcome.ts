/**
 * SESSION OUTCOME vs PROCESS — Spec D1 §3, §5 and §6.8, as one pure module.
 *
 * A work_session carries TWO independent facts and every session surface has
 * to read both:
 *
 *   outcome  — is the WORK finished? `open` → `completed` | `stopped`. Set by
 *              `session complete` or an operator's Stop, never by a process
 *              event. Absent on a pre-301 node, which reads as `open`.
 *   process  — is the MACHINE alive? `status` plus `endedKind`/`endedReason`.
 *
 * The row word, its tone, the avatar dot, line 2, the session tab and the
 * Interrupted grouping are all derived HERE, from the record plus the seam's
 * liveness verdict, so the list row, the panel, the home roster and the RUNS
 * strip cannot disagree about the same session. Nothing in this file reads a
 * seam or a clock it was not handed.
 *
 * The category (§3.2) still arrives on the summary from the server
 * (`internal.session_category`, db/migrations/301); `sessionCategoryOf` below
 * is the mirror the fixture seam and the state-chip table use.
 */
import type { EntityState, StatusCategory } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import { ageAgo, ageLabel } from '../kit/time';
import type { QueryFilter, StatusCategoryTab } from './types';

export type SessionOutcome = 'open' | 'completed' | 'stopped';

/** The four session tabs (Spec D1 §5.3), in display order. */
export type SessionTab = 'running' | 'interrupted' | 'completed' | 'stopped';

/** Process statuses recorded as alive. Stale/unverified rows are in here too. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['spawning', 'running', 'idle']);

/**
 * The fields of the work_session arm this module reads, loosely typed so a
 * caller holding `EntitySummary.state` (a union) or a hand-built subject can
 * pass it without narrowing first.
 */
export interface SessionRecord {
  status: string;
  outcome: SessionOutcome;
  outcomeAt: string | null;
  outcomeBy: string | null;
  outcomeSource: string | null;
  outcomeNote: string | null;
  receiptMessageId: string | null;
  endedKind: string | null;
  endedReason: string | null;
  startedAt: string | null;
  exitedAt: string | null;
}

/**
 * One `working_on` claim of the session (Spec D1 §6.3), as the row and the
 * Complete dialog need it. `endedAt` set ⇒ history, not current work.
 */
export interface SessionClaim {
  taskId: string;
  title: string;
  /** The claim's own status prop: working | waiting | blocked | in_review. */
  status: string;
  /** The task's status, when known (for "1 done"). */
  taskStatus?: string | null;
  endedAt?: string | null;
  endReason?: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Is this state the work_session arm? The one kind check session code needs. */
export function isSessionState(state: unknown): boolean {
  return (state as { kind?: unknown } | null)?.kind === 'work_session';
}

/** The session's record, or null for any other kind. */
export function sessionRecordOf(state: EntityState | unknown): SessionRecord | null {
  if (!isSessionState(state)) return null;
  const s = state as unknown as Record<string, unknown>;
  return {
    status: str(s.status) ?? 'idle',
    outcome: sessionOutcomeOf(state),
    outcomeAt: str(s.outcomeAt),
    outcomeBy: str(s.outcomeBy),
    outcomeSource: str(s.outcomeSource),
    outcomeNote: str(s.outcomeNote),
    receiptMessageId: str(s.receiptMessageId),
    endedKind: str(s.endedKind),
    endedReason: str(s.endedReason),
    startedAt: str(s.startedAt),
    exitedAt: str(s.exitedAt),
  };
}

/** Absent ⇒ `open`: a pre-301 node, or a payload cached before the column. */
export function sessionOutcomeOf(state: EntityState | unknown): SessionOutcome {
  const value = (state as { outcome?: unknown } | null)?.outcome;
  return value === 'completed' || value === 'stopped' ? value : 'open';
}

/** spawning / running / idle — the process is recorded alive (maybe stale). */
export function isProcessRecordedLive(status: string | null | undefined): boolean {
  return status != null && LIVE_STATUSES.has(status);
}

/**
 * §3.2 — the shared category, outcome first. MIRROR of
 * `internal.session_category` (db/migrations/301_session_outcome_and_claims.sql)
 * and `sessionCategory` (packages/server/src/facade/status.ts).
 */
export function sessionCategoryOf(state: EntityState | unknown): StatusCategory | undefined {
  const rec = sessionRecordOf(state);
  if (!rec) return undefined;
  if (rec.outcome === 'completed') return 'done';
  if (rec.outcome === 'stopped') return 'cancelled';
  return rec.status === 'spawning' ? 'to_do' : 'in_progress';
}

// ---------------------------------------------------------------------------
// Tabs (§5.3)
// ---------------------------------------------------------------------------

/**
 * THE PLACEMENT RULE, in order (§5.3):
 *   1. outcome stopped → Stopped, even while the process is still closing;
 *   2. process alive or not yet verified dead (stale / unverified) → Running;
 *   3. outcome open → Interrupted;
 *   4. outcome completed → Completed.
 *
 * Read off the RECORD, not the liveness verdict, exactly as the server filter
 * does: a stale row stays in Running until the ghost reaper records it `lost`
 * (§5.3.1 case 1). Every session lands in exactly one tab.
 */
export function sessionTabOf(state: EntityState | unknown): SessionTab | null {
  const rec = sessionRecordOf(state);
  if (!rec) return null;
  if (rec.outcome === 'stopped') return 'stopped';
  if (isProcessRecordedLive(rec.status)) return 'running';
  return rec.outcome === 'open' ? 'interrupted' : 'completed';
}

/**
 * The server filters behind the four tabs — the same partition as
 * `sessionTabOf`, executed by `collections.query` (`sessionStatus` ×
 * `sessionOutcome`). `deleted: 'exclude'` so the Archived chip composes as it
 * does with every other tab row.
 */
export const SESSION_TAB_FILTERS: Readonly<Record<SessionTab, QueryFilter>> = {
  running: { sessionStatus: ['spawning', 'running', 'idle'], sessionOutcome: ['open', 'completed'], deleted: 'exclude' },
  interrupted: { sessionStatus: ['exited', 'failed'], sessionOutcome: ['open'], deleted: 'exclude' },
  completed: { sessionStatus: ['exited', 'failed'], sessionOutcome: ['completed'], deleted: 'exclude' },
  stopped: { sessionOutcome: ['stopped'], deleted: 'exclude' },
};

/**
 * Running · Interrupted · Completed · Stopped. Interrupted carries `alert`: its
 * count renders as a red badge whenever it is above zero (§5.3, "the
 * Interrupted badge pulls attention").
 */
export const SESSION_TABS: readonly StatusCategoryTab[] = [
  { id: 'running', label: 'Running', filter: SESSION_TAB_FILTERS.running },
  { id: 'interrupted', label: 'Interrupted', filter: SESSION_TAB_FILTERS.interrupted, alert: true },
  { id: 'completed', label: 'Completed', filter: SESSION_TAB_FILTERS.completed },
  { id: 'stopped', label: 'Stopped', filter: SESSION_TAB_FILTERS.stopped },
];

export const SESSION_TAB_LABEL: Readonly<Record<SessionTab, string>> = {
  running: 'Running',
  interrupted: 'Interrupted',
  completed: 'Completed',
  stopped: 'Stopped',
};

// ---------------------------------------------------------------------------
// Words (§5.1, §5.3.1)
// ---------------------------------------------------------------------------

export type SessionTone = 'wait' | 'run' | 'done' | 'idle' | 'block';
/** §5.1's icon column. */
export type SessionIcon = 'spinner' | 'ring-dot' | 'check' | 'square' | 'ring-x' | 'ring';
/**
 * The avatar's process dot. `grey` is "process open" on a completed session;
 * `amber-hollow` is a stale or unverified record; null draws nothing.
 */
export type SessionDot = 'green' | 'amber' | 'amber-hollow' | 'red' | 'grey' | null;

/**
 * Which row of §5.1 (or which awkward case of §5.3.1) a session is in. Stable
 * ids, so groups, tests and styling can key on them without parsing words.
 */
export type SessionCase =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'ready'
  | 'idle_no_tasks'
  | 'stale'
  | 'unverified'
  | 'finished_open'
  | 'completed'
  | 'stopped'
  | 'stopped_closing'
  | 'crashed'
  | 'credential'
  | 'lost'
  | 'ended'
  | 'finished_not_closed'
  | 'failed_start'
  | 'failed_resume';

export interface SessionWord {
  case: SessionCase;
  /** The visible row word. */
  word: string;
  tone: SessionTone;
  icon: SessionIcon;
  dot: SessionDot;
  /** Needs a human: the open-and-ended cases (§5.1 rows 7-11) and Waiting. */
  attention: boolean;
  /** One plain sentence for the tooltip, or null. */
  reason: string | null;
}

export interface SessionWordContext {
  /** `Date.now()` by default; tests pass a fixed instant. */
  now?: number;
  /** The session's claims, active and ended. Absent ⇒ unknown, not "none". */
  claims?: readonly SessionClaim[];
  /** Tasks offered to it and not yet claimed (§6.3 R1). */
  offered?: number;
  /** The process is idle with pending forms — "Waiting for you" (§5.1 row 3). */
  waiting?: boolean;
  /** Bytes are moving right now — "Streaming" in place of "Working". */
  streaming?: boolean;
  /** The last resume of this session failed at spawn (§5.3.1 case 11). */
  resumeFailed?: boolean;
  /** Resolve an actor id to a display name, for "Stopped by Subhang". */
  actorName?: (actorId: string) => string | undefined;
  /** When the session last did anything — "Idle 3h" (§5.3.1 case 2). */
  activityAt?: string | null;
}

const ACTIVE_BLOCKING = new Set(['working', 'waiting']);

/** Claims that are current work (no `endedAt`). */
export function activeClaims(claims: readonly SessionClaim[] | undefined): readonly SessionClaim[] {
  return (claims ?? []).filter((c) => !c.endedAt);
}

/**
 * R6/R7: every active claim is in_review or blocked (or already ended), and
 * the session claimed something at all. A session that never claimed a task
 * is NOT "ready" — it is idle (§5.3.1 case 2).
 */
export function isReadyToComplete(claims: readonly SessionClaim[] | undefined): boolean {
  if (!claims || claims.length === 0) return false;
  return activeClaims(claims).every((c) => !ACTIVE_BLOCKING.has(c.status));
}

/** The claims that block `session complete` (`claims_open`). */
export function blockingClaims(claims: readonly SessionClaim[] | undefined): readonly SessionClaim[] {
  return activeClaims(claims).filter((c) => ACTIVE_BLOCKING.has(c.status));
}

/**
 * The plain words for an `endedKind`, used after "Crashed …:" and in the
 * Interrupted group headers. `exited_clean` and `stopped_by_operator` have no
 * crash phrase: they are not crashes.
 */
const ENDED_PHRASE: Readonly<Record<string, string>> = {
  out_of_memory: 'out of memory',
  server_restart: 'server restart',
  runtime_lost: 'runtime lost',
  container_stopped: 'container stopped',
  crashed: 'process crashed',
  unknown: 'unknown cause',
  lost: 'process lost',
  credential_revoked: 'credential disconnected',
};

/** The short reason for an ending: the kind's phrase, else the node's sentence. */
export function endedPhraseOf(rec: Pick<SessionRecord, 'endedKind' | 'endedReason'>): string | null {
  return (rec.endedKind ? ENDED_PHRASE[rec.endedKind] : undefined) ?? rec.endedReason ?? null;
}

const CRASH_KINDS = new Set(['crashed', 'out_of_memory', 'server_restart', 'runtime_lost', 'container_stopped', 'unknown']);

function word(
  c: SessionCase,
  text: string,
  tone: SessionTone,
  icon: SessionIcon,
  dot: SessionDot,
  attention: boolean,
  reason: string | null = null,
): SessionWord {
  return { case: c, word: text, tone, icon, dot, attention, reason };
}

/**
 * THE ROW WORD (§5.1) — it describes the OUTCOME; while the outcome is open it
 * describes what the process is doing. Plus the §5.3.1 words: Ready to
 * complete, Idle 3h, Finished still open / not closed out, Failed to start /
 * resume, Stopped still closing.
 *
 * `liveness` is the seam's verdict (R-UI-5): consulted only for a process the
 * record says is running or idle, where it tells Working from Stale and
 * Unverified. Absent ⇒ trust the record.
 */
export function sessionRowWord(
  state: EntityState | unknown,
  liveness?: SessionLiveness,
  ctx: SessionWordContext = {},
): SessionWord | null {
  const rec = sessionRecordOf(state);
  if (!rec) return null;
  const recordedLive = isProcessRecordedLive(rec.status);

  if (rec.outcome === 'stopped') {
    // §5.3.1 case 6: the outcome wins; the kill is still being retried.
    return recordedLive
      ? word('stopped_closing', 'Stopped, still closing…', 'idle', 'square', null, false,
          'Stopped without completing. The process has not closed yet; the stop is retried.')
      : word('stopped', 'Stopped', 'idle', 'square', null, false, rec.outcomeNote);
  }

  if (rec.outcome === 'completed') {
    // §5.1 row 4 / §5.3 "Finished, still open": the work is done and the
    // process is still open; Stop closes it. A crash after completion is a
    // grey fact, never an alert (scenario 3).
    return recordedLive
      ? word('finished_open', 'Finished, still open', 'done', 'check', 'grey', Boolean(ctx.waiting),
          'Completed. The process is still open: Stop closes it and frees its slot.')
      : word('completed', 'Completed', 'done', 'check', null, false);
  }

  // -- outcome open ---------------------------------------------------------
  if (rec.status === 'spawning') return word('starting', 'Starting', 'wait', 'spinner', null, false);

  if (recordedLive) {
    if (liveness === 'stale') {
      return word('stale', 'Stale', 'wait', 'ring-dot', 'amber-hollow', false,
        'The record says running, but the node has no live process for it. The ghost reaper records it lost after a few minutes.');
    }
    if (liveness === 'unknown') {
      return word('unverified', 'Unverified', 'wait', 'ring-dot', 'amber-hollow', false,
        'No fresh liveness snapshot from this node: the record says running, unverified.');
    }
    if (ctx.waiting) return word('waiting', 'Waiting for you', 'wait', 'ring-dot', 'amber', true);
    if (isReadyToComplete(ctx.claims)) {
      return word('ready', 'Ready to complete', 'done', 'ring-dot', 'green', false,
        'Every claimed task is in review, blocked or finished. Complete it with a receipt.');
    }
    // §5.3.1 case 2: never claimed a task and sitting idle.
    if (ctx.claims && ctx.claims.length === 0 && rec.status === 'idle') {
      const age = ageLabel(ctx.activityAt ?? null, ctx.now ?? Date.now());
      return word('idle_no_tasks', age ? `Idle ${age}` : 'Idle', 'idle', 'ring-dot', 'green', false,
        'This session never claimed a task. Complete it with a receipt when it is done.');
    }
    return word('working', ctx.streaming ? 'Streaming' : 'Working', 'run', 'ring-dot', 'green', false);
  }

  // -- open, process ended: Interrupted -------------------------------------
  const reason = rec.endedReason;
  if (rec.status === 'failed' && rec.endedKind === null) {
    const resumed = ctx.resumeFailed === true || /resum/i.test(reason ?? '');
    return resumed
      ? word('failed_resume', 'Failed to resume', 'block', 'ring-x', 'red', true, reason)
      : word('failed_start', 'Failed to start', 'block', 'ring-x', 'red', true, reason);
  }
  if (rec.endedKind === 'credential_revoked') {
    return word('credential', 'Credential disconnected', 'block', 'ring-x', 'red', true, reason);
  }
  if (rec.endedKind === 'lost') return word('lost', 'Lost', 'block', 'ring-x', 'red', true, reason);
  if (rec.status === 'failed' || (rec.endedKind !== null && CRASH_KINDS.has(rec.endedKind))) {
    return word('crashed', 'Crashed', 'block', 'ring-x', 'red', true, reason);
  }
  // exited. §5.3.1 case 3: a clean exit with no claim still being worked is a
  // one-shot worker that finished and never ran `session complete`. A label
  // only — nothing completes it automatically.
  if (rec.endedKind === 'exited_clean' && ctx.claims !== undefined && blockingClaims(ctx.claims).length === 0) {
    return word('finished_not_closed', 'Finished, not closed out', 'wait', 'ring', null, true,
      'The process exited cleanly and no task is still being worked, but the session never ran `session complete`.');
  }
  return word('ended', 'Ended, not completed', 'wait', 'ring', null, true, reason);
}

/** Open + ended: §5.1 rows 7-11. The session needs someone to resume, complete or stop it. */
export function sessionNeedsAttentionOf(state: EntityState | unknown): boolean {
  const rec = sessionRecordOf(state);
  return rec !== null && rec.outcome === 'open' && !isProcessRecordedLive(rec.status);
}

// ---------------------------------------------------------------------------
// Line 2 (§5.2, §6.8)
// ---------------------------------------------------------------------------

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * The claim tally for a working row: "2 tasks · 1 done · 1 offered" (§6.8).
 * Null when there is nothing to say.
 */
/**
 * How many tasks are OFFERED to this session (§6.3 R1) — handed to it and not
 * yet claimed — from the server's `offeredTaskIds` (301). Absent ⇒ 0.
 */
export function offeredCountOf(state: EntityState | unknown): number {
  const ids = (state as { offeredTaskIds?: unknown } | null | undefined)?.offeredTaskIds;
  return Array.isArray(ids) ? ids.length : 0;
}

export function claimTally(claims: readonly SessionClaim[] | undefined, offered = 0): string | null {
  const parts: string[] = [];
  const active = activeClaims(claims);
  if (active.length > 0) parts.push(plural(active.length, 'task'));
  const done = (claims ?? []).filter((c) => c.endedAt && c.endReason === 'task_done').length;
  if (done > 0) parts.push(`${done} done`);
  if (offered > 0) parts.push(`${offered} offered`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * LINE 2 — reason and age (§5.2):
 *   "Completed 12m ago · receipt"
 *   "Stopped by Subhang 3h ago"
 *   "Crashed 5m ago: out of memory"
 *   "Working · 2 tasks · 1 done · 1 offered"
 */
export function sessionLineTwo(
  state: EntityState | unknown,
  liveness?: SessionLiveness,
  ctx: SessionWordContext = {},
): string | null {
  const rec = sessionRecordOf(state);
  const w = sessionRowWord(state, liveness, ctx);
  if (!rec || !w) return null;
  const now = ctx.now ?? Date.now();
  const since = (iso: string | null) => {
    const age = ageLabel(iso, now);
    return age ? ` ${ageAgo(age)}` : '';
  };

  switch (w.case) {
    case 'completed':
    case 'finished_open':
      return `Completed${since(rec.outcomeAt)}${rec.receiptMessageId ? ' · receipt' : ''}`;
    case 'stopped':
    case 'stopped_closing': {
      const who = rec.outcomeSource === 'backfill'
        ? null
        : (rec.outcomeBy ? (ctx.actorName?.(rec.outcomeBy) ?? 'an operator') : null);
      return `Stopped${who ? ` by ${who}` : ''}${since(rec.outcomeAt)}${rec.outcomeNote ? `: ${rec.outcomeNote}` : ''}`;
    }
    case 'crashed':
    case 'lost':
    case 'credential':
    case 'failed_start':
    case 'failed_resume':
    case 'ended':
    case 'finished_not_closed': {
      const lead = w.case === 'crashed' ? 'Crashed'
        : w.case === 'lost' ? 'Lost'
          : w.case === 'credential' ? 'Credential disconnected'
            : w.case === 'failed_start' ? 'Failed to start'
              : w.case === 'failed_resume' ? 'Failed to resume'
                : 'Ended';
      const phrase = w.case === 'crashed' ? endedPhraseOf(rec) : rec.endedReason;
      return `${lead}${since(rec.exitedAt)}${phrase ? `: ${phrase}` : ''}`;
    }
    case 'starting':
      return null;
    default: {
      const tally = claimTally(ctx.claims, ctx.offered);
      return tally ? `${w.word} · ${tally}` : null;
    }
  }
}

/** The panel header pill: the word, with the crash reason folded in ("Crashed: out of memory"). */
export function sessionHeadline(
  state: EntityState | unknown,
  liveness?: SessionLiveness,
  ctx: SessionWordContext = {},
): string | null {
  const rec = sessionRecordOf(state);
  const w = sessionRowWord(state, liveness, ctx);
  if (!rec || !w) return null;
  if (w.case === 'crashed') {
    const phrase = endedPhraseOf(rec);
    return phrase ? `Crashed: ${phrase}` : 'Crashed';
  }
  return w.word;
}

// ---------------------------------------------------------------------------
// Row actions (§5.2)
// ---------------------------------------------------------------------------

/**
 * The verbs a session row offers, by case (§5.2). Refs, not components:
 *   working / waiting / ready / idle / stale  → complete-session, terminate
 *   finished, still open                      → close-process ("Stop")
 *   completed, process closed                 → reopen-session, follow-up
 *   stopped                                   → resume
 *   crashed / lost / credential / ended …     → resume, complete-session, dismiss-session
 */
export type SessionVerb =
  | 'complete-session'
  | 'terminate'
  | 'close-process'
  | 'follow-up'
  | 'reopen-session'
  | 'resume'
  | 'dismiss-session'
  | 'mark-lost';

export function sessionVerbsOf(state: EntityState | unknown, liveness?: SessionLiveness): readonly SessionVerb[] {
  const rec = sessionRecordOf(state);
  if (!rec) return [];
  const live = isProcessRecordedLive(rec.status);
  // Q2 = B (owner, 6 Oct): a completed session may be REOPENED by an
  // explicit, logged resume once its process has closed. While the process
  // is still open the only verb is Stop; Reopen appears after it closes.
  if (rec.outcome === 'completed') return live ? ['close-process'] : ['reopen-session', 'follow-up'];
  if (rec.outcome === 'stopped') return live ? ['close-process'] : ['resume'];
  if (live) {
    // §5.6 Stale: "Resume · Mark lost" lives in the panel's StaleFallback; the
    // row keeps Complete and Terminate, so a ghost is still retirable.
    return liveness === 'stale' ? ['complete-session', 'terminate', 'mark-lost'] : ['complete-session', 'terminate'];
  }
  return ['resume', 'complete-session', 'dismiss-session'];
}

// ---------------------------------------------------------------------------
// Tab grouping (§5.3 layouts, §5.3.1 cases 3, 4, 7)
// ---------------------------------------------------------------------------

/** An Interrupted group key: one per reason, bulk-actionable. */
export type InterruptedGroup =
  | 'finished_not_closed'
  | 'server_restart'
  | 'credential'
  | 'crashed'
  | 'lost'
  | 'ended'
  | 'failed_start'
  | 'failed_resume';

const INTERRUPTED_ORDER: readonly InterruptedGroup[] = [
  'finished_not_closed', 'server_restart', 'credential', 'crashed', 'lost', 'ended', 'failed_resume', 'failed_start',
];

const INTERRUPTED_LABEL: Readonly<Record<InterruptedGroup, string>> = {
  finished_not_closed: 'Finished, not closed out',
  server_restart: 'Server restart',
  credential: 'Credential disconnected',
  crashed: 'Crashed',
  lost: 'Lost',
  ended: 'Ended, not completed',
  failed_start: 'Failed to start',
  failed_resume: 'Failed to resume',
};

/** The bulk verb a group offers (§5.3.1 cases 3, 4). */
export type GroupBulk = 'complete-all' | 'resume-all' | 'reconnect-resume-all' | 'stop-all-finished' | null;

const INTERRUPTED_BULK: Readonly<Record<InterruptedGroup, GroupBulk>> = {
  finished_not_closed: 'complete-all',
  server_restart: 'resume-all',
  credential: 'reconnect-resume-all',
  crashed: 'resume-all',
  lost: 'resume-all',
  ended: null,
  failed_start: null,
  failed_resume: null,
};

export function interruptedGroupOf(state: EntityState | unknown, ctx: SessionWordContext = {}): InterruptedGroup | null {
  const rec = sessionRecordOf(state);
  const w = sessionRowWord(state, undefined, ctx);
  if (!rec || !w || sessionTabOf(state) !== 'interrupted') return null;
  if (w.case === 'crashed') return rec.endedKind === 'server_restart' ? 'server_restart' : 'crashed';
  switch (w.case) {
    case 'finished_not_closed':
    case 'credential':
    case 'lost':
    case 'failed_start':
    case 'failed_resume':
      return w.case;
    default:
      return 'ended';
  }
}

export interface SessionRowGroup<R> {
  id: string;
  /** Null ⇒ no header (the Running tab's working rows). */
  label: string | null;
  rows: R[];
  bulk: GroupBulk;
}

/**
 * Partition a tab's rows for display.
 *
 *   Running     — working rows first (no header), then the divider
 *                 "Finished, still open (N)" with Stop all finished.
 *   Interrupted — one group per reason, "Finished, not closed out" first,
 *                 each with its bulk verb ("Server restart (12)").
 *   Others      — one headerless group.
 *
 * Order inside a group is the caller's order (the server's sort).
 */
export function groupSessionRows<R>(
  tab: string | null | undefined,
  rows: readonly R[],
  stateOf: (row: R) => EntityState | unknown,
  ctxOf: (row: R) => SessionWordContext = () => ({}),
): SessionRowGroup<R>[] {
  if (tab === 'running') {
    const working: R[] = [];
    const finished: R[] = [];
    for (const row of rows) (sessionOutcomeOf(stateOf(row)) === 'completed' ? finished : working).push(row);
    const groups: SessionRowGroup<R>[] = [{ id: 'working', label: null, rows: working, bulk: null }];
    if (finished.length > 0) {
      groups.push({ id: 'finished_open', label: `Finished, still open (${finished.length})`, rows: finished, bulk: 'stop-all-finished' });
    }
    return groups;
  }
  if (tab === 'interrupted') {
    const by = new Map<InterruptedGroup, R[]>();
    for (const row of rows) {
      const g = interruptedGroupOf(stateOf(row), ctxOf(row)) ?? 'ended';
      by.set(g, [...(by.get(g) ?? []), row]);
    }
    return INTERRUPTED_ORDER.filter((g) => by.has(g)).map((g) => ({
      id: g,
      label: `${INTERRUPTED_LABEL[g]} (${by.get(g)!.length})`,
      rows: by.get(g)!,
      bulk: INTERRUPTED_BULK[g],
    }));
  }
  return [{ id: 'all', label: null, rows: [...rows], bulk: null }];
}

/**
 * §5.3.1 case 7 — a child whose parent sits in ANOTHER tab renders at the top
 * level with "↳ under <parent> (<Tab>)". Null when the parent is in this tab
 * (it nests normally), unknown, or absent.
 */
export function crossTabBreadcrumb(
  parent: { title: string; state: EntityState | unknown } | undefined,
  currentTab: string | null | undefined,
): string | null {
  if (!parent || !currentTab) return null;
  const tab = sessionTabOf(parent.state);
  if (tab === null || tab === currentTab) return null;
  return `↳ under ${parent.title || 'Session'} (${SESSION_TAB_LABEL[tab]})`;
}

// ---------------------------------------------------------------------------
// Case 12 — grace before a row leaves Running
// ---------------------------------------------------------------------------

/** About 10 s (§5.3.1 case 12). */
export const RUNNING_GRACE_MS = 10_000;

/**
 * Which rows to SHOW in a tab, given the rows the query returns now, the rows
 * it returned before (with when each was last seen), and the clock.
 *
 * A row that has just left the query keeps its last-seen summary on screen for
 * `graceMs`, so a process that dies and is resumed within seconds — or a live
 * event that arrives late — does not make the row jump out of Running and back.
 * Pure: the hook in `panels/list/useRunningGrace.ts` owns the timer.
 */
export function withGrace<R extends { id: string }>(
  current: readonly R[],
  lingering: ReadonlyMap<string, { row: R; leftAt: number }>,
  now: number,
  graceMs = RUNNING_GRACE_MS,
): R[] {
  const present = new Set(current.map((r) => r.id));
  const extra = [...lingering.values()]
    .filter((l) => !present.has(l.row.id) && now - l.leftAt < graceMs)
    .map((l) => l.row);
  return [...current, ...extra];
}

// ---------------------------------------------------------------------------
// Claims from edges
// ---------------------------------------------------------------------------

/**
 * A session's claims from its `working_on` edges (session → task). Props are
 * Spec D1 §6.9: `status`, `endedAt`, `endReason`.
 */
export function claimsFromEdges(
  sessionId: string,
  edges: readonly { type: string; source: { id: string }; target: { id: string; title: string; state: unknown }; props?: Record<string, unknown> }[],
): SessionClaim[] {
  return edges
    .filter((e) => e.type === 'working_on' && e.source.id === sessionId)
    .map((e) => {
      const props = e.props ?? {};
      const taskStatus = str((e.target.state as { status?: unknown } | null)?.status);
      return {
        taskId: e.target.id,
        title: e.target.title,
        status: str(props.status) ?? taskStatus ?? 'working',
        taskStatus,
        endedAt: str(props.endedAt),
        endReason: str(props.endReason),
      };
    });
}

// ---------------------------------------------------------------------------
// Case 10 — spawn refused at the session limit
// ---------------------------------------------------------------------------

/**
 * §5.3.1 case 10: a spawn refused with `session concurrency cap reached`
 * names its cause and the remedy. Completed sessions no longer count toward
 * the limit server-side, so the remaining ✓ rows are spare capacity the
 * operator reclaims with Stop all finished (Running tab). Null for any other
 * refusal. "N of N" is quoted only when the node's message carries the numbers.
 */
export function capRefusalHint(message: string | null | undefined): string | null {
  if (!message || !/concurrency cap/i.test(message)) return null;
  const nums = message.match(/(\d+)\s*(?:of|\/)\s*(\d+)/);
  const used = nums ? `${nums[1]} of ${nums[2]} slots used. ` : 'Every session slot is in use. ';
  return `${used}Finished sessions whose process is still open hold a slot until it closes — Stop all finished from the Sessions list (Running tab), then launch again.`;
}
