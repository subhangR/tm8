import type { ReactNode } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { Timestamp } from '../kit/Timestamp';
import { absolute } from './format';
import { loopRowStatus, loopStateOf } from './row-facts';

/** The Work browser row's second line for a loop (row-facts.ts says why); null for any other kind. */
export function loopRowNoteOf(row: EntitySummary): ReactNode | null {
  const state = loopStateOf(row);
  if (!state) return null;
  const status = loopRowStatus(state);
  return (
    <span className="loop-row-note" data-testid={`loop-row-note-${row.id}`}>
      <span className="loop-row-note__schedule" title={`Read in ${state.timezone}`}>{state.schedule} · {state.timezone}</span>
      {' · '}
      {status === 'disabled' ? <span className="loop-row-note__off">Disabled</span>
        : status === 'paused' ? <Timestamp at={state.pausedUntil} prefix="paused, resumes" title="Paused until" />
          : state.nextRunAt ? <Timestamp at={state.nextRunAt} prefix="next" title={absolute(state.nextRunAt, state.timezone)} />
            : <span className="loop-row-note__off">not scheduled</span>}
      {/* The server also stores a park reason here (a schedule that never matches), so it is an error, not a failed run. */}
      {state.lastError ? <span className="loop-row-note__error" title={state.lastError}> · last error</span> : null}
    </span>
  );
}
