import { useState } from 'react';
import type { CommandResult, EntityDetail } from '@tm8/contract';
import type { AuthoringCommands } from '../authoring/commands';
import { absTime } from '../kit/time';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import type { LoopsClient } from './api';

type LoopAction = 'enable' | 'disable' | 'run-now';

type ActionState =
  | { phase: 'idle' }
  | { phase: 'saving'; action: LoopAction }
  | { phase: 'saved'; message: string }
  | { phase: 'error'; message: string };

export function LoopControls({
  detail,
  loops,
  onSaved,
}: {
  detail: EntityDetail;
  commands?: Pick<AuthoringCommands, 'patchEntity'> | null;
  /** `loops.*`: Enable/Disable/Run now go through the loop doors, which own the next run (design 01a182d4 §3.1). */
  loops?: LoopsClient | null;
  onSaved?: (result: CommandResult) => void;
}) {
  const content = detail.content as unknown as Record<string, unknown>;
  const state = detail.state as unknown as Record<string, unknown>;
  const schedule = typeof content.schedule === 'string'
    ? content.schedule
    : typeof state.schedule === 'string' ? state.schedule : '';
  const enabled = typeof content.enabled === 'boolean'
    ? content.enabled
    : state.enabled === true;
  const nextRunAt = typeof content.nextRunAt === 'string'
    ? content.nextRunAt
    : typeof state.nextRunAt === 'string' ? state.nextRunAt : null;
  /*
   * A NULL RUNNER IS A CHOICE, NOT A GAP: 087 routes a loop with no
   * `teamMemberId` through the Dispatcher, which picks the teammate per firing.
   * Printing nothing would read as a missing value, so the summary says which
   * of the two it is.
   */
  const runnerRaw = typeof content.teamMemberId === 'string'
    ? content.teamMemberId
    : typeof state.teamMemberId === 'string' ? state.teamMemberId : null;
  const runsAs = runnerRaw ?? '—';
  /*
   * "ENABLED" ALONE IS NOT A HEALTH CLAIM: the scheduler records a failed
   * firing WITHOUT disabling the loop, so a summary drawing only `enabled`
   * renders a broken loop as fine. Both facts, side by side.
   */
  const lastError = typeof content.lastError === 'string' && content.lastError.length > 0
    ? content.lastError
    : typeof state.lastError === 'string' && state.lastError.length > 0 ? state.lastError : null;
  const [action, setAction] = useState<ActionState>({ phase: 'idle' });
  const pending = action.phase === 'saving';

  const unavailable = !detail.capabilities.canEdit
    ? { cause: 'You cannot manage this loop', remedy: 'the server refuses edits for this entity' }
    : !loops
      ? { cause: 'Loop controls are not wired here', remedy: 'this surface has no loops client' }
      : null;

  const commit = async (requested: LoopAction, success: string) => {
    if (!loops || unavailable || pending) return;
    setAction({ phase: 'saving', action: requested });
    const ref = { id: detail.id, version: detail.version };
    try {
      if (requested === 'enable') await loops.enable(ref);
      else if (requested === 'disable') await loops.disable(ref);
      else await loops.runNow(detail.id);
      /* The loop door answers a LoopView, not a CommandResult; the panel
         refreshes from the change feed, so the callback only signals. */
      onSaved?.({ patches: [] });
      setAction({ phase: 'saved', message: success });
    } catch (error) {
      setAction({
        phase: 'error',
        message: error instanceof Error ? error.message : 'The loop update was refused.',
      });
    }
  };

  const toggle = () => {
    if (enabled) void commit('disable', 'Disabled. The schedule is kept.');
    else void commit('enable', 'Enabled. The server scheduled the next run from now.');
  };

  const runNow = () => {
    void commit('run-now', 'Fired now.');
  };

  return (
    <div className="loop-controls" data-testid="loop-controls">
      <p className="loop-controls__summary">
        <strong>{enabled ? 'Enabled' : 'Disabled'}</strong>
        {' · '}{schedule || 'No schedule'}
        {nextRunAt ? ` · next ${formatInstant(nextRunAt)}` : ' · no next run scheduled'}
        {' · Runs as '}
        {runsAs}
        {runnerRaw === null ? ' (routed through the Dispatcher)' : ''}
      </p>
      {lastError ? (
        <p className="loop-controls__error" role="status">
          {`Last error: ${lastError}`}
        </p>
      ) : null}
      <div className="loop-controls__actions">
        {unavailable ? (
          <DisabledAction reason={unavailable} label={enabled ? 'Disable' : 'Enable'}>
            {enabled ? 'Disable' : 'Enable'}
          </DisabledAction>
        ) : (
          <button
            type="button"
            className="pn-btn"
            disabled={pending}
            aria-busy={pending && action.phase === 'saving' && action.action !== 'run-now'}
            onClick={toggle}
          >
            {pending && action.phase === 'saving' && action.action !== 'run-now'
              ? 'Saving…'
              : enabled ? 'Disable' : 'Enable'}
          </button>
        )}

        {unavailable ? (
          <DisabledAction reason={unavailable} label="Run now">Run now</DisabledAction>
        ) : !enabled ? (
          <DisabledAction
            reason={{ cause: 'This loop is disabled', remedy: 'enable it before queueing a run' }}
            label="Run now"
          >
            Run now
          </DisabledAction>
        ) : (
          <button
            type="button"
            className="pn-btn pn-btn--primary"
            disabled={pending}
            aria-busy={pending && action.phase === 'saving' && action.action === 'run-now'}
            onClick={runNow}
          >
            {pending && action.phase === 'saving' && action.action === 'run-now' ? 'Queueing…' : 'Run now'}
          </button>
        )}
      </div>
      <p className="loop-controls__status" role={action.phase === 'error' ? 'alert' : 'status'}>
        {action.phase === 'saved'
          ? action.message
          : action.phase === 'error'
            ? action.message
            : 'Run now fires the loop immediately.'}
      </p>
    </div>
  );
}

/** Unparseable reads as an em dash rather than leaking the raw ISO string. */
function formatInstant(value: string): string {
  return absTime(value) || '—';
}
