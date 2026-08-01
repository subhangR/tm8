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

export function ExitedFallback({
  /** e.g. "exit code 0 · ran 41m · ended 12m ago" — assembled by the caller. */
  meta,
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
}: {
  meta?: string;
  onOpenTranscript?: () => void;
  onResume?: () => void;
  resuming?: boolean;
  resumeDisabledReason?: string;
}) {
  // L6: never hide, never enabled-inert. An unwired or refused resume renders
  // as a DISABLED button carrying its reason — a missing button would read as
  // "this session cannot be resumed", which is a different claim entirely.
  const disabled = !onResume || Boolean(resumeDisabledReason) || Boolean(resuming);
  const reason = !onResume
    ? 'Resume is not wired on this surface yet.'
    : resumeDisabledReason;

  return (
    <div className="term-fallback" data-testid="session-exited-fallback">
      <div className="term-fallback__inner">
        <span className="term-fallback__ring" aria-hidden />
        <span className="term-fallback__title">Session exited</span>
        {meta ? <span className="term-fallback__meta">{meta}</span> : null}
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
          <button type="button" className="term-fallback__chip" onClick={onOpenTranscript}>
            View transcript ↗
          </button>
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
  onMarkExited?: () => void;
}) {
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
        <button type="button" className="term-fallback__chip" onClick={onMarkExited}>
          mark exited
        </button>
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
