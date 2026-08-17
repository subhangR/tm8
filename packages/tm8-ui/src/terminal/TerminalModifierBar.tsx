import { useCallback, useEffect, useRef, useState } from 'react';
import { AlwaysDark } from './AlwaysDark';
import { useKeyboardInset } from './useKeyboardInset';
import {
  ESC,
  TAB,
  WIDTH_NOTE,
  arrowSequence,
  columnsFor,
  widthVerdict,
  type ArrowName,
} from './mobileKeys';
import type { LiveTerminalHandle } from './LiveTerminal';

/**
 * THE ON-SCREEN MODIFIER BAR — the keys a phone does not have, and the honest
 * statement of what this terminal is for.
 *
 * ── WHY THERE IS A BAR AND NOT A BETTER KEYBOARD ─────────────────────────
 *
 * There is no way to add a key to the iOS system keyboard from a web page.
 * Esc, Ctrl, Tab and the arrows are simply not producible, so on a phone every
 * non-printable byte a PTY understands is unreachable — you can type `ls` and
 * press Return, and that is the entire vocabulary. You cannot interrupt a
 * runaway process, complete a path, or leave a full-screen program. This bar is
 * the only surface on which those exist, which is why it is anchored above the
 * keyboard rather than tucked into a menu: it is not a shortcut for something
 * reachable another way.
 *
 * ── WHAT IT INHERITS RATHER THAN INVENTS ─────────────────────────────────
 *
 * `TerminalChromeStrip`'s exit chip (`⌃\``) is the one tappable key that
 * already worked on a phone, and it is the vocabulary this follows: a small
 * dark chip, monospace, the keystroke shown as the label. There is no second
 * control language here and no second palette — every colour resolves through
 * `--pn-*` and every geometry through the mobile chrome's tokens.
 *
 * ── AND WHAT IT REFUSES TO PRETEND ───────────────────────────────────────
 *
 * The bar carries a `what this does not do` line, and that line is not a
 * disclaimer bolted on at the end — it is the feature. A phone terminal that
 * looks like a terminal and then garbles a TUI has told the user a lie they can
 * only discover by losing work. Saying "about 45 columns; full-screen tools
 * will wrap" up front costs one line and converts a mysterious failure into an
 * informed choice.
 */

export interface TerminalModifierBarProps {
  /** The live terminal this bar drives. Null while a session has no PTY — the
      bar renders disabled rather than absent, so the row does not appear and
      disappear underneath a thumb as a session changes state. */
  terminal: React.RefObject<LiveTerminalHandle | null>;
  /** Current render size in px, and the setter the A-/A+ pair drives. */
  fontSize: number;
  onFontSizeChange(next: number): void;
  /** Live grid, reported by `LiveTerminal`'s `onResize`. Null before the first
      fit — the readout says so rather than showing a plausible zero. */
  geometry: { cols: number; rows: number } | null;
  /** Measured host width in CSS px, for the "what a smaller font would buy"
      projection. Zero disables the projection rather than faking it. */
  hostWidth: number;
  cellWidth: number;
  /** False for an exited or read-only session: the keys are shown disabled so
      the surface keeps its shape, but nothing can be sent. */
  live: boolean;
  /**
   * The sticky Ctrl, CONTROLLED — owned by the parent because both halves
   * change it and neither owns it: this bar arms it, and `LiveTerminal` spends
   * it inside `onData` (the only place that sees system-keyboard input). Local
   * state here could not be cleared by the half that consumes it.
   */
  ctrlArmed: boolean;
  onCtrlArmedChange(next: boolean): void;
}

/** A key on the bar. `seq` is what reaches the PTY; `label` is what a thumb
    reads. Arrows carry no `seq` because theirs depends on DECCKM, asked per
    press — see `arrowSequence`. */
interface BarKey {
  readonly id: string;
  readonly label: string;
  readonly aria: string;
  readonly seq?: string;
  readonly arrow?: ArrowName;
}

const KEYS: readonly BarKey[] = [
  { id: 'esc', label: 'esc', aria: 'Escape', seq: ESC },
  { id: 'tab', label: 'tab', aria: 'Tab', seq: TAB },
  { id: 'left', label: '←', aria: 'Left arrow', arrow: 'left' },
  { id: 'down', label: '↓', aria: 'Down arrow', arrow: 'down' },
  { id: 'up', label: '↑', aria: 'Up arrow', arrow: 'up' },
  { id: 'right', label: '→', aria: 'Right arrow', arrow: 'right' },
];

export function TerminalModifierBar({
  terminal,
  fontSize,
  onFontSizeChange,
  geometry,
  hostWidth,
  cellWidth,
  live,
  ctrlArmed,
  onCtrlArmedChange,
}: TerminalModifierBarProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const keyboardInset = useKeyboardInset();

  /* Push the arm down into the terminal on every change, so the latch that
     actually converts the byte and the key that shows it lit can never
     disagree. One direction only: the terminal reports back through
     `onCtrlSpent`, which the parent turns into a `false` here. */
  useEffect(() => {
    terminal.current?.armCtrl(ctrlArmed);
  }, [ctrlArmed, terminal]);

  /**
   * EVERY KEY RETURNS FOCUS TO THE TERMINAL, and this is the difference
   * between a bar that works and one that is unusable.
   *
   * Tapping a button moves focus out of xterm's hidden textarea. On iOS that
   * DISMISSES THE SOFT KEYBOARD, so without an explicit refocus the sequence
   * "type ls, tap Tab to complete, keep typing" costs a keyboard dismissal and
   * a re-tap on the canvas between every single modifier press. `preventDefault`
   * on pointerdown stops the focus loss before it happens; the explicit
   * `focus()` recovers the case where it happened anyway.
   */
  const send = useCallback(
    (key: BarKey) => {
      const handle = terminal.current;
      if (!handle || !live) return;
      const seq = key.arrow ? arrowSequence(key.arrow, handle.applicationCursorKeys()) : key.seq;
      if (seq) handle.send(seq);
      handle.focus();
    },
    [terminal, live],
  );

  const toggleCtrl = useCallback(() => {
    onCtrlArmedChange(!ctrlArmed);
    terminal.current?.focus();
  }, [ctrlArmed, onCtrlArmedChange, terminal]);

  /* THE COLUMN COUNT, AND THE ONE A SMALLER FONT WOULD BUY.
     Projected from the MEASURED cell, scaled linearly by the font ratio —
     monospace cell width is proportional to font size to within a fraction of a
     pixel, and this is a projection offered before you commit, not a claim
     about a grid that exists. */
  const cols = geometry?.cols ?? 0;
  const verdict = widthVerdict(cols);
  const smallerCols =
    cellWidth > 0 && hostWidth > 0 && fontSize > 1
      ? columnsFor(hostWidth, (cellWidth * (fontSize - 1)) / fontSize)
      : 0;

  return (
    <AlwaysDark>
      <div
        className="term-mod"
        data-testid="terminal-modifier-bar"
        /* The keyboard's occluded strip, as a plain px custom property. See
           `useKeyboardInset` for why this cannot be a viewport unit. */
        style={{ '--term-mod-keyboard': `${keyboardInset}px` } as React.CSSProperties}
      >
        {detailsOpen ? (
          <div className="term-mod__panel" data-testid="terminal-mod-panel">
            {/*
              WHAT THIS TERMINAL IS FOR, STATED — the owner's ruling that the
              phone terminal ships is not a ruling that it is a desktop
              terminal, and the difference belongs on screen rather than in a
              design document nobody reading this screen has.
            */}
            <p className="term-mod__verdict" data-testid="terminal-width-verdict">
              <span className={`term-mod__cols term-mod__cols--${verdict}`}>
                {geometry ? `${geometry.cols} × ${geometry.rows}` : 'measuring…'}
              </span>
              <span className="term-mod__note">{WIDTH_NOTE[verdict]}</span>
            </p>
            <p className="term-mod__scope">
              Built for reading output and sending short commands. Not for editing in vim.
            </p>

            <div className="term-mod__row">
              <span className="term-mod__rowlabel">Text size</span>
              <button
                type="button"
                className="term-mod__key term-mod__key--wide"
                onClick={() => onFontSizeChange(fontSize - 1)}
                disabled={fontSize <= 9}
                aria-label="Smaller text — more columns"
              >
                A−
              </button>
              <span className="term-mod__size">{fontSize}px</span>
              <button
                type="button"
                className="term-mod__key term-mod__key--wide"
                onClick={() => onFontSizeChange(fontSize + 1)}
                disabled={fontSize >= 15}
                aria-label="Larger text — fewer columns"
              >
                A+
              </button>
              {/* The trade, quantified, BEFORE the tap. A control whose effect
                  you can only learn by trying it is a control you use once. */}
              {smallerCols > cols ? (
                <span className="term-mod__hint">−1px → {smallerCols} cols</span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="term-mod__keys" role="group" aria-label="Terminal modifier keys">
          <button
            type="button"
            className={`term-mod__key term-mod__key--ctrl${ctrlArmed ? ' term-mod__key--armed' : ''}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={toggleCtrl}
            disabled={!live}
            /* `aria-pressed` and not a label change: the arm is a TOGGLE STATE,
               and a screen reader that is told "Control" twice with different
               words cannot tell which of them is the current one. */
            aria-pressed={ctrlArmed}
            aria-label="Control — applies to the next key you type"
            data-testid="terminal-mod-ctrl"
          >
            ctrl
          </button>
          {KEYS.map((key) => (
            <button
              key={key.id}
              type="button"
              className="term-mod__key"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => send(key)}
              disabled={!live}
              aria-label={key.aria}
              data-testid={`terminal-mod-${key.id}`}
            >
              {key.label}
            </button>
          ))}
          {/*
            THE EXIT CHIP, AND WHY IT IS HERE AS WELL AS IN THE CHROME.
            `⌃\`` is the reserved escape from terminal focus, and on a desktop
            it is a physical chord the chip merely documents. On a phone the
            chord CANNOT BE TYPED, so the chip is not documentation — it is the
            only exit. Same class as the existing chip so it is the same object
            the user already knows from the drawer.
          */}
          <button
            type="button"
            className="term-exit-chip term-mod__exit"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => terminal.current?.blur()}
            aria-label="Exit terminal focus"
            data-testid="terminal-mod-exit"
          >
            exit <span className="term-exit-chip__key" aria-hidden>⌃`</span>
          </button>
          <button
            type="button"
            className={`term-mod__key term-mod__key--more${detailsOpen ? ' term-mod__key--armed' : ''}`}
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            aria-label={`Terminal size and limits — ${cols || '?'} columns`}
            data-testid="terminal-mod-toggle"
          >
            {/* THE COLUMN COUNT IS ON THE COLLAPSED BAR, not only inside the
                panel. A number you have to open a drawer to see is a number
                nobody sees, and this one exists to be seen before the output
                garbles rather than after. */}
            {cols ? `${cols}c` : '···'}
          </button>
        </div>
      </div>
    </AlwaysDark>
  );
}
