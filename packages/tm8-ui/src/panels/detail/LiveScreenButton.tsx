import type { EntityDetail } from '@tm8/contract';
import './live-screen.css';

/**
 * WATCH LIVE — the green blinking button an agent's test lights up on a task
 * (any kind whose registry row sets `panel.liveScreen`).
 *
 * THE SIGNAL IS A LINE IN THE TASK'S DESCRIPTION: `live: <command>`. An agent
 * that starts a live-screen test writes it; when the test ends it removes it,
 * and the button goes with it. No server change: the description is already in
 * the detail every panel holds. While the task is done or cancelled the button
 * is off whatever the description says, so a forgotten line cannot blink on
 * finished work.
 *
 * THE CLICK NEVER RUNS THE COMMAND. It opens a terminal for the viewer and puts
 * the command on their clipboard; they paste it and press Enter themselves. The
 * line is task content any member of the space can write, so typing it into the
 * viewer's shell for them would let one member run a command as another.
 */

const LIVE_LINE = /^[ \t]*live:[ \t]*(\S[^\r\n]*)$/im;
const MAX_COMMAND = 500;

/** The live command on a task, or null when no test is streaming. */
export function liveCommandOf(detail: EntityDetail | null | undefined, liveScreen: boolean | undefined): string | null {
  if (!liveScreen || !detail || detail.deletedAt) return null;
  if (detail.category === 'done' || detail.category === 'cancelled') return null;
  const description = (detail.content as { description?: unknown } | null | undefined)?.description;
  if (typeof description !== 'string') return null;
  const match = LIVE_LINE.exec(description);
  const command = match?.[1]?.trim();
  if (!command || command.length > MAX_COMMAND) return null;
  return command;
}

export function LiveScreenButton({
  command,
  onWatch,
}: {
  command: string;
  onWatch: (command: string) => void;
}) {
  return (
    <button
      type="button"
      className="pn-live"
      data-testid="watch-live"
      title={`An agent is testing this live. Opens a terminal and copies the command:\n${command}\nPaste it (Ctrl+V) and press Enter.`}
      onClick={() => onWatch(command)}
    >
      <span className="pn-live__dot" aria-hidden>◉</span>
      <span>Watch live</span>
    </button>
  );
}
