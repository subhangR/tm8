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

// The live dialog is recognised by its STRUCTURE on screen, not by its words.
// Measured on 2.1.280 (fixtures/claude-trust-dialog): the dialog is drawn with
// a ONE-column margin, so the cursor's option row is exactly ` ❯ No, exit`,
// the other option is the row directly beside it at exactly three spaces, and
// `Enter to confirm` follows within a few rows. Claude renders everything a WORKING lane shows (tool
// output under `⎿`, an assistant's code block, a quoted user turn) indented
// or prefixed (tool output at five columns under `⎿`, an assistant's lines at
// two), so a copy of the dialog printed by the agent keeps the words and the
// relative layout but never the one-column margin. (The composer's `❯` sits
// at column 0, and permission dialogs share the margin but not these option
// rows, which is why the sibling row and the confirm line are both required.) If a future Claude
// moves the frame, this stops matching and the watchdog presses nothing —
// the safe way to be wrong.
const OPTIONS = ['No, exit', 'Yes, I trust this folder'] as const;
const CURSOR_ROW = /^ ❯ (?:\d+\. )?(Yes, I trust this folder|No, exit)$/;
const siblingRow = (option: string): RegExp =>
  new RegExp(`^ {3}(?:\\d+\\. )?${option.replace(/[.,]/g, '\\$&')}$`);
const CONFIRM_ROWS_BELOW = 4;

/**
 * Claude's welcome banner, which renders only AFTER the trust gate. Once it is
 * on screen this process is past the dialog for good: the trust question is
 * asked once, at startup. Seen by the watchdog within its first reads of a
 * normal boot, long before an agent could print anything.
 */
const BOOTED_BANNER = /Claude Code v\d/;

/** Read the trust dialog off a rendered viewport (rows joined by newlines). */
export function readTrustDialog(screen: string): TrustDialogReading {
  const flat = screen.replace(/\s+/g, '');
  const framed =
    flat.includes('Yes,Itrustthisfolder') && flat.includes('No,exit') && flat.includes('Entertoconfirm');
  if (!framed) return { visible: false, selected: null };
  const rows = screen.split('\n').map((row) => row.replace(/\s+$/, ''));
  for (let i = 0; i < rows.length; i += 1) {
    const cursor = CURSOR_ROW.exec(rows[i]!);
    if (!cursor) continue;
    const other = OPTIONS.find((option) => option !== cursor[1])!;
    const sibling = siblingRow(other);
    if (!sibling.test(rows[i - 1] ?? '') && !sibling.test(rows[i + 1] ?? '')) continue;
    const below = rows.slice(i + 1, i + 2 + CONFIRM_ROWS_BELOW);
    if (!below.some((row) => row.includes('Enter to confirm'))) continue;
    return { visible: true, selected: cursor[1] === 'No, exit' ? 'no' : 'yes' };
  }
  return { visible: false, selected: null };
}

/** Claude has rendered its post-trust UI: the dialog cannot appear in this process any more. */
export function claudeBootedPastTrust(screen: string): boolean {
  return BOOTED_BANNER.test(screen);
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
  /** Stand down: the window passed with no dialog, the operator opted out, or claude booted past the gate. */
  | { kind: 'stop'; reason: 'window_elapsed' | 'opted_out' | 'booted' }
  /** The dialog survived every keystroke — fail the lane loudly. */
  | { kind: 'fail'; reason: typeof TRUST_PROMPT_UNANSWERED };

/** One step of the watchdog. Pure: the same state always yields the same action. */
export function decideTrustWatchdog(state: TrustWatchdogState): TrustWatchdogAction {
  const dialog = readTrustDialog(state.screen);
  // Past the gate: an answered dialog is recovered, and an unanswered one
  // never existed. Checked BEFORE the dialog, so text a working lane prints can
  // never be answered, whatever it looks like.
  if (claudeBootedPastTrust(state.screen)) {
    return state.keystrokes > 0 ? { kind: 'recovered' } : { kind: 'stop', reason: 'booted' };
  }
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
