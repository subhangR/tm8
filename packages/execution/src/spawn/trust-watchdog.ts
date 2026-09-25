// The PTY backstop for Claude Code's workspace-trust dialog.
//
// `trustClaudeWorkspace` seeds trust before exec, plus a long-lived trust root
// (scratch root / main repository root) a lost update cannot drop. What it
// cannot close is a lane with no qualifying root (a project that is not
// tm8-trusted, a registered subdirectory) whose own entry a booting claude
// overwrites between tm8's verify and the new claude's read. That lane parks at:
//
//   Quick safety check: Is this a project you created or one you trust? …
//   ❯ No, exit
//     Yes, I trust this folder
//   Enter to confirm · Esc to cancel
//
// with the cursor on "No, exit", writes no transcript, reports `idle`, and
// never speaks again (task 01a0d79e-1b86: ~1 in 33 fleet launches). This file
// is the pure half of the watchdog that answers it: read the screen, decide
// one keystroke. SpawnService owns the loop, the PTY and the consequences.
//
// Answering is the same decision seeding already records: `execution_spawn`
// only launches into a directory an operator vouched for. It is refused when
// the operator opted out of auto-trust.
//
// MEASURED on Claude Code 2.1.280 over a real PTY: Down-arrow as ONE write,
// then Enter, selects "Yes" and boots to the composer (claude records the
// trust itself). The digit `2` does nothing. A lone ESC byte is "Esc to
// cancel" and EXITS claude, so the arrow sequence must never be split.

/** Down-arrow, written as one chunk — a split ESC is "cancel" and exits. */
export const TRUST_SELECT_YES_KEYS = '\x1b[B';
export const TRUST_CONFIRM_KEYS = '\r';

/** Keystrokes before the watchdog gives up and fails the lane by name. */
export const TRUST_WATCHDOG_MAX_KEYSTROKES = 6;

/** Consecutive dialog-free reads after a keystroke that count as "answered". */
export const TRUST_RECOVERED_ABSENT_READS = 2;

/** The named `error` a lane is failed with when the dialog will not go away. */
export const TRUST_PROMPT_UNANSWERED = 'workspace_trust_prompt_unanswered';

export interface TrustDialogReading {
  visible: boolean;
  /** Which option the `❯` cursor is on; null when the dialog is not visible. */
  selected: 'yes' | 'no' | null;
}

// An option line holds the cursor glyph and ONE option and nothing else. This
// is what separates the live dialog from its text quoted elsewhere on screen —
// a task body describing this very bug renders the words inline, never as a
// bare `❯ No, exit` row beside the dialog's other fixed strings.
const OPTION_LINE = /^\s*❯\s*(?:\d+\.\s*)?(Yes, I trust this folder|No, exit)\s*$/m;

/** Read the trust dialog off a rendered viewport (rows joined by newlines). */
export function readTrustDialog(screen: string): TrustDialogReading {
  const flat = screen.replace(/\s+/g, '');
  const framed =
    flat.includes('Yes,Itrustthisfolder') && flat.includes('No,exit') && flat.includes('Entertoconfirm');
  const option = framed ? OPTION_LINE.exec(screen) : null;
  if (!option) return { visible: false, selected: null };
  return { visible: true, selected: option[1] === 'No, exit' ? 'no' : 'yes' };
}

export interface TrustWatchdogState {
  /** The PTY's current viewport. */
  screen: string;
  /** Since the watchdog was armed. */
  elapsedMs: number;
  /** How long to look for the dialog before standing down. */
  windowMs: number;
  /** Keystrokes already written into this dialog. */
  keystrokes: number;
  /**
   * Consecutive EARLIER reads (not this one) since the last keystroke that
   * found no dialog. A read can land mid-redraw (Ink erases, then
   * repaints), so one absent frame is not proof the dialog is gone.
   */
  absentReads: number;
  /** `TM8_AUTO_TRUST_WORKSPACE` is not `false`. */
  autoTrust: boolean;
}

export type TrustWatchdogAction =
  | { kind: 'wait' }
  /** Cursor is on "No, exit": move it. NEVER Enter here — that exits claude. */
  | { kind: 'select-yes' }
  /** Cursor is on "Yes, I trust this folder": confirm it. */
  | { kind: 'confirm' }
  /** The dialog was up, was answered, and is gone. */
  | { kind: 'recovered' }
  /** Stand down: the window passed with no dialog, or the operator opted out. */
  | { kind: 'stop'; reason: 'window_elapsed' | 'opted_out' }
  /** The dialog survived every keystroke — fail the lane loudly. */
  | { kind: 'fail'; reason: typeof TRUST_PROMPT_UNANSWERED };

/** One step of the watchdog. Pure: the same state always yields the same action. */
export function decideTrustWatchdog(state: TrustWatchdogState): TrustWatchdogAction {
  const dialog = readTrustDialog(state.screen);
  if (!dialog.visible) {
    if (state.keystrokes > 0) {
      return state.absentReads + 1 >= TRUST_RECOVERED_ABSENT_READS ? { kind: 'recovered' } : { kind: 'wait' };
    }
    return state.elapsedMs >= state.windowMs ? { kind: 'stop', reason: 'window_elapsed' } : { kind: 'wait' };
  }
  // The operator asked tm8 not to decide trust. A person answers this one; the
  // service says so loudly in the log rather than pressing keys for them.
  if (!state.autoTrust) return { kind: 'stop', reason: 'opted_out' };
  if (state.keystrokes >= TRUST_WATCHDOG_MAX_KEYSTROKES) {
    return { kind: 'fail', reason: TRUST_PROMPT_UNANSWERED };
  }
  return dialog.selected === 'yes' ? { kind: 'confirm' } : { kind: 'select-yes' };
}
