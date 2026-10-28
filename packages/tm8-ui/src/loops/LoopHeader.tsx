import { useState, type ReactNode } from 'react';
import { isCollabError, type CommandContext, type CommandResult, type EntityId } from '@tm8/contract';
import { nextMutationId } from '../authoring/commands';
import { Pill } from '../kit/Pill';
import { ActorRef } from '../kit/ActorRef';
import { absTime, relTime, useNow } from '../kit/time';
import { DisabledAction, type UnavailableReason } from '../panels/honesty/DisabledWithReason';
import { PauseDialog } from './PauseDialog';
import type { LoopPagePort, LoopRun, LoopView } from './page-port';
import {
  RUN_STATUS, errorText, isNotImplemented, isOverlap, loopStatus, overlapRunId, zonedInstant,
} from './page-format';

/*
 * THE LOOP PAGE HEADER: what state the loop is in, when it fires next, what
 * last went wrong, who armed it — and the verbs that change those facts,
 * drawn beside them so the fact and its control cannot drift apart.
 *
 * Every control is honest about capabilities (`LoopView.capabilities`, per
 * viewer): a verb the server would refuse renders as a DisabledAction with the
 * reason, never hidden and never a dead button. Every write carries the
 * view's version and every command returns the new `LoopView`, so the header
 * redraws from the server's answer and never guesses.
 */

export interface LoopHeaderProps {
  view: LoopView;
  port: LoopPagePort;
  /** New view from a command — the shared page slot. */
  onView(view: LoopView): void;
  /** Re-read after a refusal that means our copy is stale. */
  onReload(): Promise<void> | void;
  /** A run was created or changed: the runs table re-reads. */
  onRunsChanged(): void;
  onOpenEntity?: (id: string) => void;
  /** `entities.delete`; absent ⇒ Delete is refused with a reason. */
  deleteEntity?: (id: EntityId, ctx?: CommandContext) => Promise<CommandResult>;
  /** The edit form (PR5a's LoopFormDialog); absent ⇒ Edit is refused with a reason. */
  renderEditor?: (props: { view: LoopView; onClose(): void; onSaved(view: LoopView): void }) => ReactNode;
}

type Busy = null | 'run' | 'toggle' | 'resume' | 'delete';

type Notice =
  | { kind: 'none' }
  | { kind: 'error'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'run'; run: LoopRun }
  | { kind: 'overlap'; text: string; liveRunId: string | null };

const NO_CONTROL: UnavailableReason = { cause: 'You cannot control this loop', remedy: 'the server reports canControl: false for you' };
const NO_RUN: UnavailableReason = { cause: 'You cannot run this loop', remedy: 'the server reports canRun: false for you' };
const NO_EDIT: UnavailableReason = { cause: 'You cannot edit this loop', remedy: 'the server reports canEdit: false for you' };
const NO_DELETE: UnavailableReason = { cause: 'You cannot delete this loop', remedy: 'the server reports canDelete: false for you' };

export function LoopHeader({
  view, port, onView, onReload, onRunsChanged, onOpenEntity, deleteEntity, renderEditor,
}: LoopHeaderProps) {
  const now = useNow();
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>({ kind: 'none' });
  const [pausing, setPausing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { state, capabilities: can, definition } = view;
  const zone = definition.timezone || 'UTC';
  const status = loopStatus(view, now);

  const refused = async (failure: unknown, fallback: string) => {
    if (isCollabError(failure) && failure.code === 'version_conflict') {
      setNotice({ kind: 'error', text: 'This loop changed while you were looking at it. The page has reloaded; try again.' });
      await onReload();
      return;
    }
    if (isNotImplemented(failure)) {
      setNotice({ kind: 'error', text: 'This server does not support that loop control yet (501 not implemented).' });
      return;
    }
    setNotice({ kind: 'error', text: errorText(failure, fallback) });
  };

  const command = async (which: Busy, call: () => Promise<LoopView>, done: string, fallback: string) => {
    if (busy) return;
    setBusy(which); setNotice({ kind: 'none' });
    try {
      onView(await call());
      setNotice({ kind: 'info', text: done });
    } catch (failure) {
      await refused(failure, fallback);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (force: boolean) => {
    if (busy) return;
    setBusy('run'); setNotice({ kind: 'none' });
    try {
      const { run } = await (force ? port.runNow(view.id, true) : port.runNow(view.id));
      setNotice({ kind: 'run', run });
      onRunsChanged();
      void onReload();
    } catch (failure) {
      if (isOverlap(failure)) {
        setNotice({
          kind: 'overlap',
          text: errorText(failure, 'The previous run is still live.'),
          liveRunId: overlapRunId(failure),
        });
      } else {
        await refused(failure, 'Run now was refused. Nothing was started.');
      }
    } finally {
      setBusy(null);
    }
  };

  const toggle = () => (state.enabled
    ? command('toggle', () => port.disable(view),
      'Disabled. The schedule is kept; nothing fires until you enable it.', 'Disable was refused.')
    : command('toggle', () => port.enable(view),
      'Enabled. The next run is computed from now.', 'Enable was refused.'));

  const resume = () => command('resume', () => port.resume(view),
    'Resumed. A run missed during the pause fires once on the next tick.', 'Resume was refused.');

  const remove = async () => {
    if (!deleteEntity || busy) return;
    setBusy('delete'); setNotice({ kind: 'none' });
    try {
      await deleteEntity(view.id, { clientMutationId: nextMutationId() });
      setConfirmDelete(false);
      setNotice({ kind: 'info', text: 'Deleted. Its runs went with it; the tasks and sessions it made remain.' });
    } catch (failure) {
      await refused(failure, 'Delete was refused. Nothing was deleted.');
    } finally {
      setBusy(null);
    }
  };

  const control = (allowed: boolean, reason: UnavailableReason, label: string, node: ReactNode) =>
    allowed ? node : <DisabledAction key={label} reason={reason} label={label}>{label}</DisabledAction>;
  const paused = status.kind === 'paused';

  return (
    <div className="loop-page__header" data-testid="loop-header">
      <div className="loop-page__status">
        <StatusPill status={status} zone={zone} now={now} />
        <NextRun view={view} zone={zone} now={now} />
      </div>

      {state.lastError ? (
        <p className="loop-page__banner" role="alert" data-testid="loop-last-error">
          <strong>Last firing failed</strong>{state.lastRunAt ? ` ${relTime(state.lastRunAt, now)}` : ''}: {state.lastError}
          <span className="loop-page__hint"> The loop stays enabled; a failure never disables it.</span>
        </p>
      ) : null}

      <Armer view={view} now={now} onOpenEntity={onOpenEntity} />

      <div className="loop-page__actions" role="group" aria-label="Loop controls">
        {control(can.canRun, NO_RUN, 'Run now', (
          <button key="run" type="button" className="pn-btn pn-btn--primary" disabled={busy !== null}
            aria-busy={busy === 'run'} onClick={() => void runNow(false)}>
            {busy === 'run' ? 'Starting…' : 'Run now'}
          </button>
        ))}
        {paused
          ? control(can.canControl, NO_CONTROL, 'Resume', (
            <button key="resume" type="button" className="pn-btn" disabled={busy !== null} onClick={() => void resume()}>
              {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </button>
          ))
          : null}
        {control(can.canControl, NO_CONTROL, paused ? 'Change pause…' : 'Pause…', (
          <button key="pause" type="button" className="pn-btn" disabled={busy !== null || !state.enabled}
            title={state.enabled ? undefined : 'A disabled loop does not fire; enable it before pausing'}
            onClick={() => setPausing(true)}>
            {paused ? 'Change pause…' : 'Pause…'}
          </button>
        ))}
        {control(can.canControl, NO_CONTROL, state.enabled ? 'Disable' : 'Enable', (
          <button key="toggle" type="button" className="pn-btn" disabled={busy !== null}
            aria-busy={busy === 'toggle'} onClick={() => void toggle()}>
            {busy === 'toggle' ? 'Saving…' : state.enabled ? 'Disable' : 'Enable'}
          </button>
        ))}
        {!renderEditor
          ? <DisabledAction key="edit" reason={{ cause: 'Editing is not wired here', remedy: 'this surface has no loop form' }} label="Edit">Edit</DisabledAction>
          : control(can.canEdit, NO_EDIT, 'Edit', (
            <button key="edit" type="button" className="pn-btn" disabled={busy !== null} onClick={() => setEditing(true)}>Edit</button>
          ))}
        {!deleteEntity
          ? <DisabledAction key="delete" reason={{ cause: 'Delete is not wired here', remedy: 'this surface has no delete executor' }} label="Delete">Delete</DisabledAction>
          : control(can.canDelete, NO_DELETE, 'Delete', (
            <button key="delete" type="button" className="pn-btn" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>Delete</button>
          ))}
      </div>

      {confirmDelete ? (
        <div className="loop-page__confirm" role="alertdialog" aria-label="Confirm delete">
          <p>Delete “{definition.title}”? Its run history is removed with it; the tasks and sessions it made remain.</p>
          <button type="button" className="pn-btn" disabled={busy === 'delete'} onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button type="button" className="pn-btn" disabled={busy === 'delete'} onClick={() => void remove()}>
            {busy === 'delete' ? 'Deleting…' : 'Delete loop'}
          </button>
        </div>
      ) : null}

      <NoticeLine notice={notice} onOpenEntity={onOpenEntity} canForce={can.canRun} busy={busy !== null} onForce={() => void runNow(true)} />

      {pausing ? (
        <PauseDialog
          view={view}
          port={port}
          onClose={() => setPausing(false)}
          onPaused={(next) => { onView(next); setNotice({ kind: 'info', text: 'Paused.' }); }}
        />
      ) : null}
      {editing && renderEditor
        ? renderEditor({ view, onClose: () => setEditing(false), onSaved: (next) => { onView(next); setEditing(false); } })
        : null}
    </div>
  );
}

function StatusPill({ status, zone, now }: { status: ReturnType<typeof loopStatus>; zone: string; now: number }) {
  if (status.kind === 'disabled') return <Pill tone="idle">Disabled</Pill>;
  if (status.kind === 'paused') {
    return <Pill tone="wait" title={absTime(status.until)}>{`Paused until ${zonedInstant(status.until, zone, now)}`}</Pill>;
  }
  if (status.kind === 'waiting') return <Pill tone="wait" dot="pulse">Waiting on previous run</Pill>;
  return <Pill tone="run" dot="solid">Enabled</Pill>;
}

function NextRun({ view, zone, now }: { view: LoopView; zone: string; now: number }) {
  const { state, schedule } = view;
  let text: string;
  if (!state.enabled) text = 'Not scheduled while disabled';
  else if (!schedule.valid) text = `Not scheduled: ${schedule.problem ?? 'the schedule does not parse'}`;
  else if (!state.nextRunAt) text = 'No next run scheduled';
  else {
    const rel = relTime(state.nextRunAt, now);
    const abs = zonedInstant(state.nextRunAt, zone, now);
    const overdue = Date.parse(state.nextRunAt) <= now;
    text = overdue ? `Next run due now (${abs})` : `Next run ${rel} (${abs})`;
  }
  return <span className="loop-page__next-run" data-testid="loop-next-run" title={state.nextRunAt ? absTime(state.nextRunAt) : undefined}>{text}</span>;
}

function Armer({ view, now, onOpenEntity }: { view: LoopView; now: number; onOpenEntity?: (id: string) => void }) {
  const { armedBy, armedAt, actingAs } = view.state;
  const acting = actingAs?.identity ?? null;
  const sameActor = acting && armedBy && acting.id === armedBy.id;
  return (
    <p className="loop-page__line" data-testid="loop-armer">
      {armedBy ? (
        <>Armed by <ActorRef actor={armedBy} onOpenSession={onOpenEntity} />{armedAt ? <span title={absTime(armedAt)}>{` ${relTime(armedAt, now)}`}</span> : null}</>
      ) : (
        <>Not armed by a human</>
      )}
      {actingAs?.via === 'none' ? (
        <span className="loop-page__warn"> · needs arming: no one it can run as. A human enabling or editing it arms it.</span>
      ) : acting && !sameActor ? (
        <> · running as <ActorRef actor={acting} onOpenSession={onOpenEntity} />{actingAs.via === 'fallback' ? ' (fallback)' : ''}</>
      ) : null}
    </p>
  );
}

function NoticeLine({
  notice, onOpenEntity, canForce, busy, onForce,
}: {
  notice: Notice;
  onOpenEntity?: (id: string) => void;
  canForce: boolean;
  busy: boolean;
  onForce(): void;
}) {
  if (notice.kind === 'none') return null;
  if (notice.kind === 'error') return <p className="loop-page__error" role="alert">{notice.text}</p>;
  if (notice.kind === 'info') return <p className="loop-page__hint" role="status">{notice.text}</p>;
  if (notice.kind === 'overlap') {
    return (
      <div className="loop-page__overlap" role="alert" data-testid="loop-overlap">
        <p>{`Not started: the previous run is still live. ${notice.text}`}</p>
        <button type="button" className="pn-btn" disabled={!canForce || busy} onClick={onForce}>Run anyway</button>
      </div>
    );
  }
  const { run } = notice;
  const tone = RUN_STATUS[run.status] ?? RUN_STATUS.running;
  return (
    <div className="loop-page__started" role="status" data-testid="loop-run-started">
      <span>{run.status === 'running' ? 'Run started' : 'Run recorded'}</span>
      <Pill tone={tone.tone}>{tone.label}</Pill>
      {run.sessionId ? (
        <button type="button" className="pn-btn pn-btn--quiet" onClick={() => onOpenEntity?.(run.sessionId!)} disabled={!onOpenEntity}>
          Open session
        </button>
      ) : null}
      {run.taskId ? (
        <button type="button" className="pn-btn pn-btn--quiet" onClick={() => onOpenEntity?.(run.taskId!)} disabled={!onOpenEntity}>
          Open task
        </button>
      ) : null}
      {run.error ? <span className="loop-page__error">{run.error}</span> : null}
    </div>
  );
}
