import { AlwaysDark } from './AlwaysDark';
import { presentationStyle, type SessionPresentation } from './session-presentation';

/**
 * THE CHROME STRIP — T0-2's one pixel-frozen row (RULING A).
 *
 * Sits directly above the terminal host and carries: who is running (persona
 * + provider), what state it is in (word + dot), and — the load-bearing part
 * — how to get your keyboard back.
 *
 * THE FOCUS-CAPTURE CONTRACT. While the canvas holds focus the terminal owns
 * every shortcut (C6 layer 3); physical Ctrl+Backquote is the single reserved
 * escape. The exit chip is the only visible instruction for that escape, so
 * it may never truncate away, hide behind overflow, or drop at a narrow
 * width. Degradation order, narrow → narrower: the PROVIDER drops first
 * (~<380px), then the NAME ellipsizes to its 56px floor; the pill and the
 * chip never shrink and never hide. At the 320 floor the chip's label
 * compacts ("exit terminal ⌃`" → "exit ⌃`") but the keystroke survives.
 */

export function TerminalChromeStrip({
  persona,
  provider,
  presentation,
  compact = false,
  onExitTerminal,
  onOpenTranscript,
  initial,
  statusDetail,
  showFocusControl = true,
}: {
  /** Persona name — the agent, e.g. "forge". */
  persona: string;
  /** Model / tool string, e.g. "claude-fable-5". First to drop when narrow. */
  provider?: string | null;
  presentation: SessionPresentation;
  /** True at the 320px floor: the exit chip label compacts, keystroke stays. */
  compact?: boolean;
  /**
   * Phase 1: no PTY exists, so there is nothing to blur away from and this is
   * absent — the chip renders as a static hint rather than a live control.
   */
  onExitTerminal?: () => void;
  /** Exited sessions swap the same slot to a transcript link. */
  onOpenTranscript?: () => void;
  initial?: string;
  /**
   * The registry's authored sentence for this verdict. Passed down rather than
   * imported: `src/terminal/` cannot ask the registry for the work_session row
   * without naming the kind, which is the §15.2 build failure — so panels/
   * fetches it and threads it here.
   */
  statusDetail?: string;
  /** False when a parent drawer keeps the same exit/transcript control in
      its always-visible collapsed row. */
  showFocusControl?: boolean;
}) {
  const style = presentationStyle(presentation);
  const ended = !style.isLive;

  return (
    <AlwaysDark>
      <div className="term-strip" data-testid="terminal-chrome-strip">
        <span
          className={ended ? 'term-strip__avatar term-strip__avatar--ended' : 'term-strip__avatar'}
          aria-hidden
        >
          {(initial ?? persona.charAt(0)).toUpperCase()}
        </span>

        <span
          className={ended ? 'term-strip__name term-strip__name--ended' : 'term-strip__name'}
          title={persona}
        >
          {persona}
        </span>

        {provider ? (
          <>
            <span className="term-strip__dot-sep" aria-hidden>
              ·
            </span>
            <span
              className={
                ended ? 'term-strip__provider term-strip__provider--ended' : 'term-strip__provider'
              }
              title={provider}
            >
              {provider}
            </span>
          </>
        ) : null}

        <span className="term-strip__spacer" />

        <StatusPill presentation={presentation} detail={statusDetail} />

        {/* One slot, two occupants: the escape hatch while alive, the record
            once dead. Identical box geometry so nothing shifts on exit. */}
        {showFocusControl && ended ? (
          <button
            type="button"
            className="term-exit-chip"
            onClick={onOpenTranscript}
            data-testid="transcript-chip"
          >
            transcript ↗
          </button>
        ) : showFocusControl ? (
          <button
            type="button"
            className="term-exit-chip"
            onClick={onExitTerminal}
            data-testid="exit-terminal-chip"
            /* The keyboard contract, stated to AT as well as to the eye. */
            aria-label="Exit terminal focus — press Control and backtick"
          >
            {compact ? 'exit ' : 'exit terminal '}
            <span className="term-exit-chip__key" aria-hidden>
              ⌃`
            </span>
          </button>
        ) : null}
      </div>
    </AlwaysDark>
  );
}

/**
 * Status is ALWAYS color + word (L10). The dot adds a second, redundant
 * channel — never the only one — so reduced-motion and monochrome both keep
 * the meaning.
 */
export function StatusPill({
  presentation,
  detail,
}: {
  presentation: SessionPresentation;
  /** The registry's sentence, when the caller has it. */
  detail?: string;
}) {
  const s = presentationStyle(presentation);
  const dotClass = [
    'term-dot',
    s.dot === 'hollow' ? 'term-dot--ended' : toneDotClass(presentation),
    s.pulse ? 'term-dot--pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={`term-pill kit-pill--${s.tone}`}
      /* The pill shows the short word; the full sentence is never lost. */
      title={detail ?? s.full}
      data-testid="session-status-pill"
      data-presentation={presentation}
    >
      <span className={dotClass} aria-hidden />
      {s.word}
    </span>
  );
}

function toneDotClass(p: SessionPresentation): string {
  const s = presentationStyle(p);
  if (s.tone === 'run') return 'term-dot--live';
  if (s.tone === 'wait') return 'term-dot--attention';
  return 'term-dot--ended';
}
