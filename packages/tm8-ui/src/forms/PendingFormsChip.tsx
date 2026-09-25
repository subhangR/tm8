/**
 * The session tile's forms chip (decision 11): "1 form waiting" when forms
 * authored from this session still wait on the viewer, and "1 answer queued"
 * when submitted answers are still waiting for the session to run (R4). The
 * tile's own click opens the session panel, where the banner lists them, so
 * the chip is a label and not a second door.
 */
import { answersQueuedText, formsWaitingText, type FormPendingSession } from './pending';
import './pending-forms.css';

/** True when the chip has something to say. Mounts ask this before drawing a badge row. */
export function hasPendingFormsChip(pending: FormPendingSession | null): pending is FormPendingSession {
  return pending !== null && (pending.total > 0 || pending.queued > 0);
}

export function PendingFormsChip({ pending }: { pending: FormPendingSession | null }) {
  if (!hasPendingFormsChip(pending)) return null;
  return (
    <>
      {pending.total > 0 ? (
        <span
          className="pn-st__count pf-chip pf-chip--waiting"
          data-testid="pending-forms-chip"
          title={pending.forms.map((f) => f.title).join('\n') || undefined}
        >
          {formsWaitingText(pending.total)}
        </span>
      ) : null}
      {pending.queued > 0 ? (
        <span
          className="pn-st__count pf-chip pf-chip--queued"
          data-testid="queued-answers-chip"
          title="Delivered when the session resumes"
        >
          {answersQueuedText(pending.queued)}
        </span>
      ) : null}
    </>
  );
}
