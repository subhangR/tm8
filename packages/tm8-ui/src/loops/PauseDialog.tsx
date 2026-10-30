import { useEffect, useRef, useState } from 'react';
import { useDismissable } from '../panels/useDismissable';
import type { LoopPagePort, LoopView } from './page-port';
import { errorText, zonedInstant } from './page-format';

const HOUR_MS = 60 * 60 * 1000;
const MAX_PAUSE_MS = 365 * 24 * HOUR_MS;

export type PausePick = 'hour' | 'tomorrow' | 'custom';

/** Tomorrow at 09:00 in the reader's own zone: "until tomorrow morning" means their morning. */
export function tomorrowAtNine(now: Date): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

/** `<input type="datetime-local">` value for an instant, in the reader's zone. */
function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a pick resolves to, or a sentence saying why it cannot be used. */
export function resolvePause(pick: PausePick, custom: string, now: Date): { until: Date } | { problem: string } {
  const until = pick === 'hour'
    ? new Date(now.getTime() + HOUR_MS)
    : pick === 'tomorrow' ? tomorrowAtNine(now) : new Date(custom);
  if (Number.isNaN(until.getTime())) return { problem: 'Pick a date and time.' };
  if (until.getTime() <= now.getTime()) return { problem: 'The pause must end in the future.' };
  if (until.getTime() > now.getTime() + MAX_PAUSE_MS) return { problem: 'A pause can last at most 365 days. Disable the loop instead.' };
  return { until };
}

export function PauseDialog({
  view,
  port,
  onClose,
  onPaused,
}: {
  view: LoopView;
  port: Pick<LoopPagePort, 'pause'>;
  onClose(): void;
  onPaused(view: LoopView): void;
}) {
  const [now] = useState(() => new Date());
  const [pick, setPick] = useState<PausePick>('hour');
  const [custom, setCustom] = useState(() => localInputValue(new Date(now.getTime() + 3 * HOUR_MS)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useDismissable(true, dialog, () => { if (!busy) onClose(); });
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('input')?.focus(); }, []);

  const resolved = resolvePause(pick, custom, now);
  const zone = view.definition.timezone || 'UTC';
  const submit = async () => {
    if (busy || 'problem' in resolved) return;
    setBusy(true); setError('');
    try {
      const next = await port.pause(view, resolved.until.toISOString());
      onPaused(next);
      onClose();
    } catch (failure) {
      setError(errorText(failure, 'The pause was refused. Nothing changed.'));
      setBusy(false);
    }
  };

  return (
    <div className="tool-dialog-backdrop">
      <div ref={dialog} className="tool-dialog loop-pause" role="dialog" aria-modal="true" aria-label={`Pause ${view.definition.title}`}>
        <h2>Pause “{view.definition.title}”</h2>
        <p className="loop-page__hint">
          While paused the loop does not fire. When the pause ends, a run it missed fires once, then the schedule resumes.
        </p>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <fieldset disabled={busy} className="loop-pause__picks">
            <legend>Pause until</legend>
            <label><input type="radio" name="pause" checked={pick === 'hour'} onChange={() => setPick('hour')} /> 1 hour</label>
            <label><input type="radio" name="pause" checked={pick === 'tomorrow'} onChange={() => setPick('tomorrow')} /> Tomorrow 09:00</label>
            <label><input type="radio" name="pause" checked={pick === 'custom'} onChange={() => setPick('custom')} /> Custom</label>
            {pick === 'custom' ? (
              <input
                type="datetime-local"
                aria-label="Pause until (date and time)"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
            ) : null}
          </fieldset>
          <p className="loop-page__hint" role="status" data-testid="pause-resolved">
            {'problem' in resolved
              ? resolved.problem
              : `Resumes ${zonedInstant(resolved.until.toISOString(), zone)}`}
          </p>
          {error ? <p role="alert" className="loop-page__error">{error}</p> : null}
          <div className="tool-actions">
            <button type="button" className="pn-btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="pn-btn pn-btn--primary" disabled={busy || 'problem' in resolved}>
              {busy ? 'Pausing…' : 'Pause'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
