/**
 * THE STAGE'S WAY BACK, AND WHETHER THE AGENT IS STILL AT IT (ruling D18).
 *
 * A stage (Graph, Fleet) takes region B whole, and since the 2026-08-19
 * ruling nothing of the chat is drawn under it — no tray, no composer. That
 * left a stage with no exit on screen and no sign the agent was still
 * working: the tray's "Chat tab pulses while busy" could never render,
 * because the tray itself only mounts when no stage is up. An answer landed
 * unseen one tab over from the conversation it belonged to.
 *
 * So the stage's own header carries one quiet line, right-aligned:
 *
 *   ● Agent working…  ·  ← Chat
 *
 * THE STATUS HAS THREE STATES AND TWO EDGES. Nothing ran while the stage was
 * up: no words. A turn is running: `Agent working…` with a pulsing dot. It
 * ended while the stage was up: `Agent finished`, dot solid, until the stage
 * closes — that is the cue to go back. The span is `role="status"` and its
 * text moves only at those two edges, so a screen reader hears at most two
 * sentences. It is mounted EMPTY rather than absent when nothing ran: a live
 * region that appears already holding text is not reliably announced.
 *
 * `← Chat` and Escape are the same verb (the screen wires both to it).
 */
import { useState } from 'react';
import './stage-exit.css';

export function StageExit({
  busy,
  onExit,
}: {
  /** The conversation behind the stage is working right now. */
  busy: boolean;
  onExit: () => void;
}) {
  /* "It finished" is only true of a turn this stage SAW running. The flag is
     set during render — React's "adjusting state when a prop changes" — so
     the first frame that shows `busy` already agrees with it. It lives and
     dies with the stage: this component mounts inside the stage header. */
  const [sawBusy, setSawBusy] = useState(busy);
  if (busy && !sawBusy) setSawBusy(true);
  const state = busy ? 'working' : sawBusy ? 'finished' : null;

  return (
    <span className="tch-stage-exit" data-testid="stage-exit">
      <span className="tch-stage-exit__status" role="status" data-state={state ?? undefined}>
        {state ? (
          <>
            <span className="tch-stage-exit__dot" aria-hidden />
            {state === 'working' ? 'Agent working…' : 'Agent finished'}
          </>
        ) : null}
      </span>
      {state ? <span className="tch-stage-exit__sep" aria-hidden>·</span> : null}
      <button
        type="button"
        className="tch-stage-exit__back"
        data-testid="stage-exit-back"
        aria-label="Back to chat"
        onClick={onExit}
      >
        <span aria-hidden>←</span> Chat
      </button>
    </span>
  );
}
