import { useEffect, useState } from 'react';
import type { SpaceId } from '@tm8/contract';
import type { LoopSchedulePreview, LoopsClient } from './api';
import { absolute } from './format';

/** How long typing must pause before the server is asked. */
export const PREVIEW_DEBOUNCE_MS = 300;

export type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; preview: LoopSchedulePreview }
  | { phase: 'error'; message: string };

/**
 * The server's reading of a schedule while a human types: debounced, and
 * a late answer for an older expression never overwrites a newer one.
 */
export function useSchedulePreview(
  client: Pick<LoopsClient, 'schedulePreview'> | null,
  spaceId: SpaceId,
  schedule: string,
  timezone: string,
): PreviewState {
  const [state, setState] = useState<PreviewState>({ phase: 'idle' });
  useEffect(() => {
    if (!client || schedule.trim() === '') { setState({ phase: 'idle' }); return; }
    let live = true;
    setState(previous => (previous.phase === 'ready' ? previous : { phase: 'loading' }));
    const timer = setTimeout(() => {
      client.schedulePreview(spaceId, schedule, timezone, 5).then(
        preview => { if (live) setState({ phase: 'ready', preview }); },
        (error: unknown) => {
          if (live) setState({ phase: 'error', message: error instanceof Error ? error.message : 'The preview was refused.' });
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [client, spaceId, schedule, timezone]);
  return state;
}

export function SchedulePreviewPanel({ state, timezone }: { state: PreviewState; timezone: string }) {
  return (
    <div className="loop-form__preview" data-testid="loop-schedule-preview" aria-live="polite">
      {state.phase === 'idle' ? <p className="loop-form__muted">Pick a schedule to see when it runs.</p> : null}
      {state.phase === 'loading' ? <p className="loop-form__muted">Checking the schedule…</p> : null}
      {state.phase === 'error' ? <p className="au-dialog__missing" role="alert">{state.message}</p> : null}
      {state.phase === 'ready' && !state.preview.valid ? (
        <p className="au-dialog__missing" role="alert" data-testid="loop-schedule-problem">
          {state.preview.problem ?? 'The server cannot read this schedule.'}
        </p>
      ) : null}
      {state.phase === 'ready' && state.preview.valid ? (
        <>
          <p className="loop-form__summary" data-testid="loop-schedule-summary">{state.preview.summary}</p>
          {state.preview.next.length > 0 ? (
            <ol className="loop-form__next" aria-label="Next runs">
              {state.preview.next.map(instant => (
                <li key={instant}>
                  <time dateTime={instant} title={absolute(instant)}>{absolute(instant, timezone)}</time>
                </li>
              ))}
            </ol>
          ) : <p className="loop-form__muted">No upcoming runs.</p>}
        </>
      ) : null}
    </div>
  );
}
