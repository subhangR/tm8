/**
 * WHEN THERE IS NO CANVAS — the exited and stale fallbacks (T0-2 §4).
 *
 * Only the canvas region swaps; the header, seam, strip and footer keep exact
 * geometry, so nothing jumps when a session ends. The fallback REJOINS THE
 * THEME (paper in light, graphite in dark) while the strip above it stays
 * dark — deliberate, and the canvas explains why: "death reads as the terminal
 * literally leaving the panel."
 *
 * EXITED and STALE are NOT variants of one state, and rendering them alike
 * would be the exact dishonesty this program exists to avoid:
 *   · exited — proven over: the process ended, we know when and how.
 *   · stale  — the record claims running and the node has no PTY for it. We
 *     are contradicting our own record, so the copy says so plainly and
 *     offers the only honest remedy (correct the record), never "reconnect",
 *     which cannot work.
 */
import type { ReactNode } from 'react';
import { ageAgo, ageLabel, useNow } from '../kit/time';
import { exitFactsLine, outcomeTitle } from '../transcript/session-stats';
import {
  endedPhraseOf,
  sessionHeadline,
  sessionLineTwo,
  sessionRecordOf,
  sessionRowWord,
  type ActionRef,
} from '../domain';

export function ExitedFallback({
  /**
   * WHICH ENDING THIS WAS. `TerminalBody` maps both `failed` and `exited` onto
   * this one canvas, and both used to read "Session exited" while the
   * presentation layer correctly called the first one `failed` — the strip and
   * the interior disagreeing about the same session (drift D3,
   * HANDOVER-SessionAnatomy.md). The word is the fix; there is deliberately no
   * red exit CODE, because the contract projects none on any node and a number
   * invented here would claim a measurement nobody took.
   *
   * Defaulted rather than required: `exited` is the state this component was
   * written for, so an unaware caller keeps the reading it already had.
   */
  outcome = 'exited',
  /**
   * THE SESSION'S OWN TIMESTAMPS, superseding the `meta: string` this component
   * used to accept. That prop existed for exactly this line and its only caller
   * never passed one, so the oracle's `ran 41m · ended 12m ago` had never
   * rendered on any screen (drift D1, HANDOVER-SessionAnatomy.md:88).
   *
   * The RECORD arrives, not a pre-formatted sentence: a string prop is a second
   * place for a host to word the same fact differently, and it cannot carry a
   * relative label without freezing it at the caller's render. Both are null on
   * a session whose row never closed out, and the line says so.
   */
  startedAt,
  exitedAt,
  onOpenTranscript,
  onResume,
  /** True while a resume is in flight — the button must not be double-fired. */
  resuming,
  /**
   * Why resume is unavailable for THIS session, when it is. Server-owned
   * truth (e.g. a session spawned before native-id capture existed), never a
   * guess assembled here.
   */
  resumeDisabledReason,
  /**
   * THE POST-MORTEM, when a host has wired one. A ReactNode rather than data
   * because the numbers come from `execution.transcript` and this layer holds
   * no seam — the same reason `debugSurface` and `gitSurface` arrive as nodes.
   * Absent, the canvas keeps exactly the shape it had.
   */
  stats,
  /**
   * SPEC D1 §5.6 — the session's own state, so the canvas can say which
   * ENDING this is for the WORK, not only for the process:
   *   Completed  — receipt, "completed Y ago · process closed Z ago", Follow-up;
   *                a crash after completion is one grey line, never an alert.
   *   Stopped    — "Stopped by <actor> <time>", Resume.
   *   Crashed / Lost / Credential / Ended — the reason in red or amber,
   *                Resume · Complete · Stop for good.
   * Absent ⇒ the pre-D1 canvas, unchanged.
   */
  sessionState,
  /** Complete / Stop for good, by verb. Absent ⇒ those render refused. */
  onSessionVerb,
  actorName,
}: {
  sessionState?: unknown;
  onSessionVerb?: (ref: ActionRef) => void;
  actorName?: (actorId: string) => string | undefined;
  outcome?: 'exited' | 'failed';
  startedAt?: string | null;
  exitedAt?: string | null;
  onOpenTranscript?: () => void;
  onResume?: () => void;
  resuming?: boolean;
  resumeDisabledReason?: string;
  stats?: ReactNode;
}) {
  // L6: never hide, never enabled-inert. An unwired or refused resume renders
  // as a DISABLED button carrying its reason — a missing button would read as
  // "this session cannot be resumed", which is a different claim entirely.
  const disabled = !onResume || Boolean(resumeDisabledReason) || Boolean(resuming);
  const reason = !onResume
    ? 'Resume is not wired on this surface yet.'
    : resumeDisabledReason;

  /* The shared 30s clock, subscribed ONLY here. This component mounts on a dead
     session, so the tick can never reach the live terminal's render path — the
     reason the line is assembled inside rather than by `TerminalBody`, which is
     also the parent of `LiveTerminal`. */
  const now = useNow();
  const meta =
    startedAt == null && exitedAt == null
      ? null
      : exitFactsLine({ startedAt, exitedAt, now });

  const record = sessionRecordOf(sessionState);
  if (record && record.outcome !== 'open') {
    return (
      <SettledFallback
        state={sessionState}
        startedAt={startedAt}
        exitedAt={exitedAt}
        now={now}
        meta={meta}
        onOpenTranscript={onOpenTranscript}
        onResume={onResume}
        resuming={resuming}
        resumeDisabledReason={resumeDisabledReason}
        actorName={actorName}
        onSessionVerb={onSessionVerb}
        stats={stats}
      />
    );
  }
  /* Open + ended (§5.6 "Crashed / lost / credential / ended without
     completing"): the word and the reason, then Resume · Complete · Stop for good. */
  const word = record ? sessionRowWord(sessionState, 'not-running') : null;
  const headline = record ? sessionHeadline(sessionState, 'not-running') : null;
  const why = record ? (record.endedReason ?? endedPhraseOf(record)) : null;

  return (
    <div
      className={`term-fallback${stats ? ' term-fallback--stats' : ''}`}
      data-testid="session-exited-fallback"
      data-outcome={outcome}
    >
      <div className="term-fallback__inner">
        <span className="term-fallback__ring" aria-hidden />
        <span className="term-fallback__title" data-testid="session-ended-title">{headline ?? outcomeTitle(outcome)}</span>
        {word && why ? (
          <span
            className={`term-fallback__reason term-fallback__reason--${word.tone}`}
            data-testid="session-ended-reason"
          >
            {why}
          </span>
        ) : null}
        {meta ? (
          <span className="term-fallback__meta" data-testid="session-exit-facts">
            {meta}
          </span>
        ) : null}
        <div className="term-fallback__actions">
          <button
            type="button"
            className="term-fallback__action"
            data-testid="session-resume"
            onClick={onResume}
            disabled={disabled}
            aria-disabled={disabled}
            {...(reason ? { title: reason } : {})}
          >
            {resuming ? 'Resuming…' : 'Resume session'}
          </button>
          {/* THE SAME L6 RULE AS RESUME, applied to the control that had been
              breaking it since it was written. This button was ENABLED with
              `onClick={undefined}` on any host that did not wire
              `onOpenTranscript` — a live control that silently did nothing,
              which is the enabled-inert class this canvas bans one line above.
              It is now refused out loud instead. */}
          <button
            type="button"
            className="term-fallback__chip"
            data-testid="session-open-transcript"
            onClick={onOpenTranscript}
            disabled={!onOpenTranscript}
            aria-disabled={!onOpenTranscript}
            {...(onOpenTranscript
              ? {}
              : { title: 'The transcript surface is not wired on this view.' })}
          >
            View transcript ↗
          </button>
          {record ? (
            <>
              <button
                type="button"
                className="term-fallback__chip"
                data-testid="session-ended-complete"
                onClick={() => onSessionVerb?.('complete-session')}
                disabled={!onSessionVerb}
                {...(onSessionVerb ? {} : { title: 'Completing is not wired on this view.' })}
              >
                Complete
              </button>
              <button
                type="button"
                className="term-fallback__chip"
                data-testid="session-ended-stop"
                onClick={() => onSessionVerb?.('dismiss-session')}
                disabled={!onSessionVerb}
                {...(onSessionVerb ? {} : { title: 'Stopping is not wired on this view.' })}
              >
                Stop for good
              </button>
            </>
          ) : null}
        </div>
        {/* The record-survival sentence stays; "Read-only" does NOT. A session
            that can be resumed is not read-only, and keeping that word next to
            a live Resume button would be the same copy dishonesty the stale
            fallback exists to avoid.

            The refusal is ADDITIONAL, never a replacement: an earlier draft
            swapped the caption out for the reason, which quietly dropped the
            "your record survives" fact in exactly the case a user is most
            likely to fear losing it. */}
        <span className="term-fallback__caption">
          The session record, discussion and connections stay.
          {reason
            ? ''
            : ' Resume restores the agent’s own conversation — it picks up where it stopped, it does not start over.'}
        </span>
        {reason ? (
          <span className="term-fallback__meta" data-testid="session-resume-reason">
            {reason}
          </span>
        ) : null}
        {/* BELOW the verdict and the controls, deliberately. Resume is the
            highest-value thing on this screen and a wall of figures above it
            would push it under the fold on a short panel. */}
        {stats ?? null}
      </div>
    </div>
  );
}

/**
 * SPEC D1 §5.6 — an ended session whose WORK is settled: Completed (receipt,
 * the ages, Follow-up) or Stopped (who and when, Resume). A completed
 * session's later crash is one grey line here and nothing else (scenario 3).
 */
function SettledFallback({
  state,
  startedAt,
  exitedAt,
  now,
  meta,
  onOpenTranscript,
  onResume,
  resuming,
  resumeDisabledReason,
  actorName,
  onSessionVerb,
  stats,
}: {
  onSessionVerb?: (ref: ActionRef) => void;
  state: unknown;
  startedAt?: string | null;
  exitedAt?: string | null;
  now: number;
  meta: string | null;
  onOpenTranscript?: () => void;
  onResume?: () => void;
  resuming?: boolean;
  resumeDisabledReason?: string;
  actorName?: (actorId: string) => string | undefined;
  stats?: ReactNode;
}) {
  const record = sessionRecordOf(state)!;
  const completed = record.outcome === 'completed';
  const age = (iso: string | null | undefined) => {
    const a = ageLabel(iso ?? null, now);
    return a ? ageAgo(a) : null;
  };
  // "ran 41m" — the first clause of the shared exit-facts line.
  const ran = startedAt && exitedAt ? (exitFactsLine({ startedAt, exitedAt, now }).split(' · ')[0] ?? null) : null;
  const crashedAfter = completed && record.status === 'failed';
  const resumeDisabled = !onResume || Boolean(resumeDisabledReason) || Boolean(resuming);
  return (
    <div
      className={`term-fallback${stats ? ' term-fallback--stats' : ''}`}
      data-testid="session-exited-fallback"
      data-outcome={record.outcome}
    >
      <div className="term-fallback__inner">
        <span className="term-fallback__ring" aria-hidden />
        <span className="term-fallback__title" data-testid="session-ended-title">{completed ? 'Completed' : 'Stopped'}</span>
        {completed ? (
          <>
            <span className="term-fallback__receipt" data-testid="session-receipt-card">
              {record.receiptMessageId ? 'Receipt recorded — the close-out message on this session.' : 'Completed without a recorded receipt (backfill).'}
            </span>
            <span className="term-fallback__meta" data-testid="session-exit-facts">
              {[
                ran,
                record.outcomeAt ? `completed ${age(record.outcomeAt) ?? ''}`.trim() : null,
                exitedAt ? `process closed ${age(exitedAt) ?? ''}`.trim() : null,
              ].filter(Boolean).join(' · ') || meta}
            </span>
            {crashedAfter ? (
              <span className="term-fallback__meta" data-testid="session-crash-after-completion">
                The process {endedPhraseOf(record) ?? 'ended'} after the work completed — nothing to do.
              </span>
            ) : null}
          </>
        ) : (
          <span className="term-fallback__meta" data-testid="session-exit-facts">
            {sessionLineTwo(state, 'not-running', { now, ...(actorName ? { actorName } : {}) })}
          </span>
        )}
        <div className="term-fallback__actions">
          {completed ? (
            <>
            {/* Q2 = B: a completed session whose process has closed can be
                REOPENED: a confirmed, logged resume; the receipt stays. */}
            <button
              type="button"
              className="term-fallback__action"
              data-testid="session-reopen"
              onClick={() => onSessionVerb?.('reopen-session')}
              disabled={!onSessionVerb}
              aria-disabled={!onSessionVerb}
              title={onSessionVerb
                ? 'Reopens this completed session; its receipt stays in history.'
                : 'Reopening is not wired on this view.'}
            >
              Reopen (resume)
            </button>
            <button
              type="button"
              className="term-fallback__chip"
              data-testid="session-follow-up"
              disabled
              aria-disabled
              title="Follow-up sessions are coming with D4. Start a new session on the same tasks for now."
            >
              Start follow-up session
            </button>
            </>
          ) : (
            <button
              type="button"
              className="term-fallback__action"
              data-testid="session-resume"
              onClick={onResume}
              disabled={resumeDisabled}
              aria-disabled={resumeDisabled}
              {...(!onResume ? { title: 'Resume is not wired on this surface yet.' } : resumeDisabledReason ? { title: resumeDisabledReason } : {})}
            >
              {resuming ? 'Resuming…' : 'Resume session'}
            </button>
          )}
          <button
            type="button"
            className="term-fallback__chip"
            data-testid="session-open-transcript"
            onClick={onOpenTranscript}
            disabled={!onOpenTranscript}
            aria-disabled={!onOpenTranscript}
            {...(onOpenTranscript ? {} : { title: 'The transcript surface is not wired on this view.' })}
          >
            View transcript ↗
          </button>
        </div>
        {stats ?? null}
      </div>
    </div>
  );
}

export function StaleFallback({
  label,
  reason,
  onMarkExited,
}: {
  /**
   * The registry's WORD for this verdict (`liveTreatment('stale').label`).
   * Passed in rather than written here: the long form is a verdict sentence
   * and `src/domain/` owns it. Absent, the pill shows the bare state name —
   * the state's own name, not a second authored sentence.
   */
  label?: string;
  /**
   * The registry's authored explanation for the `stale` verdict. Passed in
   * rather than restated so the honesty copy has exactly one home.
   */
  reason?: string;
  /**
   * Record this session as exited. Absent ⇒ the chip renders DISABLED with a
   * reason, exactly as `ExitedFallback` treats an unwired `onResume` — see the
   * L6 note there, which this now obeys too.
   */
  onMarkExited?: () => void;
}) {
  // L6, the same ruling `ExitedFallback` applies to Resume. This chip had been
  // rendering ENABLED with `onClick={undefined}` since it was written, which is
  // the enabled-inert control `no-op-handler-ban.test.ts` bans as a package law
  // — and it is the one control this screen exists to offer, on the one screen
  // a user reaches after a node restart killed their work.
  const markDisabled = !onMarkExited;

  return (
    <div className="term-fallback" data-testid="session-stale-fallback">
      <div className="term-fallback__inner">
        {/* Amber, never green. A record without proof does not get to borrow
            the color of a proven-live session. */}
        <span className="term-fallback__stale-pill">{`⚠ ${label ?? 'stale'}`}</span>
        <span className="term-fallback__stale-body">
          This session reported running, but its process is gone. Liveness never lies.
        </span>
        {reason ? <span className="term-fallback__meta">{reason}</span> : null}
        <button
          type="button"
          className="term-fallback__chip"
          data-testid="session-mark-exited"
          onClick={onMarkExited}
          disabled={markDisabled}
          {...(markDisabled
            ? { title: 'Marking lost is not wired on this surface yet.' }
            : { title: 'Record the process as lost now — the ghost reaper, for this session. The work stays open: resume, complete or stop it.' })}
        >
          {/* Spec D1 §5.6: "mark exited" became MARK LOST — a process fact
              (`failed / lost`), never an outcome, so the session moves to
              Interrupted and its claims are kept. */}
          Mark lost
        </button>
        {markDisabled ? (
          <span className="term-fallback__meta" data-testid="session-stale-mark-unwired">
            Marking lost is not wired on this surface yet.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The `unknown` verdict — no fresh snapshot. Distinct from both above: we are
 * not claiming the session ended, and we are not claiming it runs. The one
 * honest statement is that we do not know, and the reason says why.
 */
export function UnverifiedFallback({ label, reason }: { label?: string; reason?: string }) {
  return (
    <div className="term-fallback" data-testid="session-unverified-fallback">
      <div className="term-fallback__inner">
        <span className="term-fallback__ring" aria-hidden />
        {/* The registry's word, threaded in. This was the THIRD instance of the
            same duplication — caption, then strip tooltip, then this title —
            each found only by re-grepping the phrase rather than trusting that
            the previous fix had cleared the class. */}
        <span className="term-fallback__title">{label ?? 'Unverified'}</span>
        {/* NO default sentence. The registry's liveTreatment(verdict).reason is
            the single authored explanation for this state and TerminalBody
            threads it in; writing a second one here — however similar — is the
            copy drift the registry exists to prevent. When it is absent the
            title and pill still identify the state completely, and saying
            nothing is honest in a way that a near-duplicate is not. */}
        {reason ? <span className="term-fallback__caption">{reason}</span> : null}
      </div>
    </div>
  );
}
