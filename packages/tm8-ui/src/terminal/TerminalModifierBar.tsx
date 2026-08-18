import { useCallback, useEffect, useState } from 'react';
import { AlwaysDark } from './AlwaysDark';
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

/**
 * TWO ROWS, AND THE ARITHMETIC THAT FORCED THEM — DEF-010.
 *
 * MEASURED: at phone-390 the single key row bled 77px (`hscroll`
 * `term-mod__keys`), the size/limits toggle sat 69px past the right edge, and
 * `exit` was sliced by it. At 430 the toggle was still 29px over.
 *
 * IT WAS NEVER GOING TO FIT, and the stylesheet's claim that "at 390px the
 * whole set fits" was simply wrong. Nine controls at the 44px floor is
 * 9 × 44 = 396px of keys alone, before a single gap and before the bar's own
 * padding, against 390px of viewport. The row was already over budget by
 * construction.
 *
 * WHY NOT SCROLL IT — it already did. `overflow-x: auto` is what turned an
 * impossible row into a row whose last two controls are off-screen, and one of
 * those is `exit`, which on a phone is THE ONLY WAY OUT of terminal focus
 * (the `⌃\`` chord it documents cannot be typed here). A control that requires
 * discovering a horizontal scroll inside a bar to reach is, for the person who
 * does not discover it, the same as absent.
 *
 * WHY NOT SHRINK THEM — `mobile/CONTRACT.md` §6: the floor is on the SMALLER
 * side and a key that shrinks below it is a key that fails the finger it was
 * added for. These keys exist because a phone keyboard cannot produce them; a
 * ctrl you miss is worse than no ctrl, because you believe you sent it.
 *
 * SO THE SET SPLITS BY WHAT THE KEYS ARE FOR, not by what happens to fit.
 * MODIFIERS carries ctrl / esc / tab and the two chips that are about the
 * terminal rather than about typing into it (exit, and the column readout).
 * ARROWS carries the four together, which is also how they read: a cluster,
 * scanned as a shape, not four items in a queue.
 *
 * Budget at 390, the number this replaces the old comment's guess with:
 *   modifiers  3×44 + 2 gaps + exit ~86 + cols ~48 + 16 padding  ≈ 294
 *   arrows     4×44 + 3 gaps + 16 padding                        ≈ 204
 * Both inside 390, and both still inside 320 with room.
 */
const MODIFIER_KEYS: readonly BarKey[] = [
  { id: 'esc', label: 'esc', aria: 'Escape', seq: ESC },
  { id: 'tab', label: 'tab', aria: 'Tab', seq: TAB },
];

const ARROW_KEYS: readonly BarKey[] = [
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

  /*
   * THE KEYBOARD LISTENER THAT USED TO BE HERE IS GONE — `mobile/CONTRACT.md`
   * §3, and it was also a DOUBLE COUNT.
   *
   * This bar called `useKeyboardInset()` itself and published the result as
   * `--term-mod-keyboard`, which `terminal.css` spent on
   * `transform: translateY(-inset)` plus a compensating `padding-bottom`. That
   * was correct when this bar was the only surface that knew the keyboard
   * existed. It is not any more: `MobileFrame` now measures the inset ONCE and
   * SHRINKS THE WHOLE FRAME by it (`calc(100dvh - var(--mobile-keyboard-inset))`),
   * so every region inside — header, content, notices, tab bar, sheets, and
   * this bar with them — is already above the keyboard without knowing it is
   * there.
   *
   * Lifting again on top of that raises the bar by a second keyboard-height,
   * over the terminal output it is meant to sit beneath — covering the last
   * lines of exactly the thing you opened the terminal to read.
   *
   * HONESTY LABEL, because it belongs beside the code and not only in a report:
   * this reasoning is from the frame's arithmetic, not from a photograph. The
   * harness this program uses has no soft keyboard to emulate, so the fix is a
   * code-seam claim and it is on the real-device checklist. What is NOT in
   * doubt is the contract: "a lane must not wire its own keyboard listener …
   * three surfaces with three arithmetics is three bugs."
   */

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
      <div className="term-mod" data-testid="terminal-modifier-bar">
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

        {/* ROW 1 — the modifiers, plus the two chips that are ABOUT the
            terminal rather than input into it. */}
        <div
          className="term-mod__keys term-mod__keys--mods"
          role="group"
          aria-label="Terminal modifier keys"
        >
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
          {MODIFIER_KEYS.map((key) => (
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

            IT STAYS ON THE FIRST ROW deliberately. It was the control the old
            single row sliced, and the row a thumb reaches first is the row the
            only-way-out belongs on.
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

        {/* ROW 2 — the arrows, kept together. Their own group and their own
            label, so a screen reader is told they are a cluster rather than
            four more items appended to the modifiers. */}
        <div
          className="term-mod__keys term-mod__keys--arrows"
          role="group"
          aria-label="Terminal arrow keys"
        >
          {ARROW_KEYS.map((key) => (
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
        </div>
      </div>
    </AlwaysDark>
  );
}
