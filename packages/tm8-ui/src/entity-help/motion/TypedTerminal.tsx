/**
 * TYPED TERMINAL — a CLI demonstration that types itself.
 *
 * THE FRAME IS ALWAYS GRAPHITE. The terminal opens its own
 * `.cv2-root[data-theme="dark"]` scope — tokens.css's own selector — so it
 * resolves the dark palette in BOTH themes through the same tokens the app
 * uses everywhere; nothing here is a hard-coded colour. `EntityDetailPanel`'s
 * always-dark ink stage uses the identical mechanism.
 *
 * TWO RENDERINGS OF ONE TEXT. The visible screen types character by character
 * and is `aria-hidden`; a visually hidden copy carries the complete text from
 * the first frame, so a screen reader reads the demonstration whole rather
 * than one letter at a time. Under reduced motion the visible screen IS the
 * whole text, and the replay control is not drawn — there is nothing to
 * replay.
 *
 * Lines beginning `#` are commentary; every other line is a command and gets
 * the prompt. The prompt is drawn, not typed: it is chrome, not content.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMotion } from './MotionContext';

export interface TypedTerminalProps {
  lines: readonly string[];
  /** The title-bar caption: what this demonstration shows. */
  title?: string | undefined;
  /** Milliseconds per character. */
  speed?: number | undefined;
  /** Milliseconds of rest at the end of each line. */
  lineGap?: number | undefined;
  /** Milliseconds before the first character. */
  delay?: number | undefined;
}

export function TypedTerminal({ lines, title, speed = 16, lineGap = 320, delay = 200 }: TypedTerminalProps) {
  const { reduced } = useMotion();
  const script = useMemo(() => lines.join('\n'), [lines]);
  const total = script.length;
  const [typed, setTyped] = useState<number>(reduced ? total : 0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (reduced) {
      setTyped(total);
      return;
    }
    setTyped(0);
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      cursor += 1;
      setTyped(cursor);
      if (cursor >= total) return;
      /* Rest at a line break so each command lands as a unit. */
      const wait = script[cursor - 1] === '\n' ? lineGap : speed;
      timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, delay);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [script, total, reduced, speed, lineGap, delay, run]);

  const done = typed >= total;
  const shown = script.slice(0, typed).split('\n');
  const complete = script.split('\n');

  return (
    <div
      className="cv2-root eh-term"
      data-theme="dark"
      role="group"
      aria-label={title ?? 'Terminal demonstration'}
      data-typed={done ? 'complete' : 'typing'}
    >
      <div className="eh-term__bar" aria-hidden>
        <span className="eh-term__dots">
          <i />
          <i />
          <i />
        </span>
        <span className="eh-term__title">{title ?? 'tm8'}</span>
        {!reduced && done ? (
          <button
            type="button"
            className="eh-term__replay"
            aria-hidden
            tabIndex={-1}
            onClick={() => setRun((n) => n + 1)}
            title="Replay"
          >
            ↻
          </button>
        ) : null}
      </div>
      <pre className="eh-term__screen" aria-hidden>
        {shown.map((line, index) => {
          const last = index === shown.length - 1;
          const full = complete[index] ?? '';
          const comment = full.startsWith('#');
          return (
            <span key={index} className={comment ? 'eh-term__line eh-term__line--comment' : 'eh-term__line'}>
              {comment ? null : <span className="eh-term__prompt">$ </span>}
              {line}
              {last && !done ? <span className="eh-term__caret" /> : null}
              {'\n'}
            </span>
          );
        })}
      </pre>
      <pre className="eh-sr-only">{script}</pre>
    </div>
  );
}
