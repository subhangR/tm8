/**
 * SIGNATURE STAGE — the frame each authored kind's one signature moment plays in.
 *
 * WHY A STAGE. Wave 1's brief asks every page for one moment that belongs to
 * its kind alone: a chat turn crossing its states, a task passing its gate, a
 * session's heartbeat. Those scenes differ; how they START, how they REPLAY
 * and how they STAND STILL must not, so that lives here once.
 *
 * THE STILL PICTURE IS THE BASE STYLE. Every animated element's resting CSS
 * is its final state; the keyframes only say where it comes FROM, with fill
 * `both`. So when motion is removed — `useMotion().reduced`, the dialog's
 * `[data-motion='reduced']`, or the OS query — the scene is simply the whole
 * scene, with nothing waiting on a timer. No element carries meaning that the
 * still frame lacks, and every label is real text a screen reader reads.
 *
 * IT PLAYS WHEN SEEN. A beat can sit below the fold; a scene that finished
 * while nobody was looking is no scene. The stage arms (animations assigned,
 * paused on their first frame) and plays once a third of it is on screen.
 * Where `IntersectionObserver` is missing (jsdom) it plays at once.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMotion } from '../motion/MotionContext';
import './signature.css';

export interface SignatureStageProps {
  /** The mono caption above the scene: `ONE TURN, START TO FINISH`. */
  readonly caption: string;
  /** The scene's accessible name, and the replay button's subject. */
  readonly label: string;
  /** A kind-scoped class for the scene's own layout (`ehs-chat`). */
  readonly className: string;
  readonly children: ReactNode;
}

type Phase = 'armed' | 'playing';

export function SignatureStage({ caption, label, className, children }: SignatureStageProps) {
  const { reduced } = useMotion();
  const ref = useRef<HTMLElement>(null);
  const [phase, setPhase] = useState<Phase>('armed');
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setPhase('playing');
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setPhase('playing');
          observer.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [reduced]);

  const mode = reduced ? 'ehs--still' : `ehs--${phase}`;
  return (
    <figure ref={ref} className={`ehs ${mode} ${className}`} aria-label={label} data-testid="signature-stage">
      <figcaption className="ehs__caption">
        <span className="eh-eyebrow">{caption}</span>
        {reduced ? null : (
          <button type="button" className="ehs__replay" onClick={() => setRun((n) => n + 1)} aria-label={`Replay: ${label}`}>
            ↻ Replay
          </button>
        )}
      </figcaption>
      <div className="ehs__stage" key={run}>
        {children}
      </div>
    </figure>
  );
}

/** The stage's clock: `at(900)` puts an element's entrance 900ms into the scene. */
export function at(ms: number): CSSProperties {
  return { ['--ehs-t' as string]: `${ms}ms` } as CSSProperties;
}
