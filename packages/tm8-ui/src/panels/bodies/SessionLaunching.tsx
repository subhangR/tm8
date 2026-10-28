/**
 * THE LAUNCHING PAGE (task 01a182d2) — what a pressed Launch shows until its
 * session is live: the launch line, the boot phases ticking off, an elapsed
 * clock, and — when it fails — the node's own reason with Edit and retry and
 * Dismiss.
 *
 * CONTRACT: presentation only. In: a `LaunchPageModel` (`launch-handoff/page`,
 * the one place its state is decided) and, from context, the page's host
 * (`launch-handoff/actions`; absent ⇒ no buttons). Out: the verbs' calls.
 *
 * ONE PAGE ON BOTH SIDES OF THE SWAP. Work's launch tab draws it before the
 * node has answered, and the session's work view draws it while the session
 * boots — so the moment the tab becomes the session's, the viewer sees the
 * same page carry on, not a second one replacing it.
 */
import { useEffect, useState } from 'react';
import {
  formatElapsed,
  launchPageModel,
  useLaunchForSession,
  useLaunchPageHost,
  type BootingSession,
  type BootStep,
  type LaunchPageModel,
  type LaunchPageState,
  type PhaseMark,
} from '../../launch-handoff';
import './session-launching.css';

const EYEBROW: Record<Exclude<LaunchPageState, 'live'>, string> = {
  starting: 'Launching',
  checking: 'Checking',
  booting: 'Starting',
  failed: 'Launch failed',
};

/** Status is never colour alone (tokens.css): every mark also says itself. */
const MARK_WORDS: Record<PhaseMark, string> = {
  done: 'done',
  active: 'in progress',
  pending: 'not yet',
  failed: 'failed',
};

/**
 * Elapsed ms since `startedAt`, ticking while `running`: tenths matter for
 * the first ten seconds, whole seconds after, so the timer slows with them.
 */
function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      timer = setTimeout(tick, at - startedAt < 10_000 ? 100 : 1_000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [startedAt, running]);
  return Math.max(0, now - startedAt);
}

/**
 * The page for a session's work view while it boots, or null once the
 * session's own surfaces should show. A failed boot stays on the page only
 * when this window launched it — it holds the launch, so it can offer the
 * retry; any other failed session is the work view's to tell.
 */
export function useSessionLaunching(boot: BootingSession | null): LaunchPageModel | null {
  const record = useLaunchForSession(boot?.id);
  /* A recorded boot overwrites its phase with `failed`, so the last step seen
     is kept to put the failure on the row after it. */
  const step = boot?.bootPhase && boot.bootPhase !== 'failed' ? boot.bootPhase : null;
  const [lastStep, setLastStep] = useState<BootStep | null>(step);
  useEffect(() => {
    if (step) setLastStep(step);
  }, [step]);
  const model = boot ? launchPageModel(record, boot, step ?? lastStep) : null;
  if (model?.state === 'booting') return model;
  if (model?.state === 'failed' && model.launchId) return model;
  return null;
}

function Mark({ mark }: { mark: PhaseMark }) {
  if (mark === 'done') {
    return (
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (mark === 'failed') {
    return (
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return null;
}

export function SessionLaunching({ model }: { model: LaunchPageModel }) {
  const actions = useLaunchPageHost();
  const running = model.state === 'starting' || model.state === 'checking' || model.state === 'booting';
  const elapsed = useElapsed(model.startedAt, running);
  const state = model.state === 'live' ? 'booting' : model.state;
  const launchId = model.launchId;

  return (
    <section
      className="slaunch"
      data-testid="session-launching"
      data-state={model.state}
      aria-busy={running}
      aria-label={`${EYEBROW[state]}: ${model.title}`}
    >
      <div className="slaunch__card">
        <header className="slaunch__head">
          <span className="slaunch__eyebrow" role="status">
            <span className="slaunch__beacon" aria-hidden="true" />
            {EYEBROW[state]}
          </span>
          {running ? (
            <span className="slaunch__clock" data-testid="session-launching-clock" aria-label={`elapsed ${formatElapsed(elapsed)}`}>
              {formatElapsed(elapsed)}
            </span>
          ) : null}
        </header>

        <h2 className="slaunch__title">{model.title}</h2>
        {model.facts.length > 0 ? (
          <p className="slaunch__line" data-testid="session-launching-line">
            {model.facts.map((fact, index) => (
              <span key={`${String(index)}:${fact}`} className="slaunch__fact">{fact}</span>
            ))}
          </p>
        ) : null}

        <ol className="slaunch__phases" aria-label="Launch progress">
          {model.phases.map((row) => (
            <li key={row.id} className="slaunch__phase" data-mark={row.mark} data-testid={`session-launching-phase-${row.id}`}>
              <span className="slaunch__mark" aria-hidden="true">
                <Mark mark={row.mark} />
              </span>
              <span className="slaunch__label">{row.label}</span>
              <span className="slaunch__detail">{row.detail}</span>
              {row.id === 'admitted' && row.mark === 'done' && model.admittedMs !== null ? (
                <span className="slaunch__at">{formatElapsed(model.admittedMs)}</span>
              ) : null}
              <span className="sr-only">{`, ${MARK_WORDS[row.mark]}`}</span>
            </li>
          ))}
        </ol>

        {model.state === 'checking' ? (
          <p className="slaunch__note" data-testid="session-launching-checking">
            The node didn’t answer in time. Checking whether the launch started before anything is retried.
          </p>
        ) : null}

        {model.failure ? (
          <div className="slaunch__failure" role="alert" data-testid="session-launching-failure">
            <p className="slaunch__reason">{model.failure.message}</p>
            {actions && launchId ? (
              <div className="slaunch__actions">
                <button
                  type="button"
                  className="pn-btn pn-btn--primary"
                  data-testid="session-launching-retry"
                  onClick={() => actions.editAndRetry(launchId)}
                >
                  Edit and retry
                </button>
                <button
                  type="button"
                  className="pn-btn"
                  data-testid="session-launching-dismiss"
                  onClick={() => actions.dismiss(launchId)}
                >
                  Dismiss
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
