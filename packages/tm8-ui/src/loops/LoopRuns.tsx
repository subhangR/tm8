import { useCallback, useEffect, useRef, useState } from 'react';
import { Pill } from '../kit/Pill';
import { absTime, elapsed, relTime, useNow } from '../kit/time';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import type { LoopPagePort, LoopRun } from './page-port';
import { RUN_STATUS, durationLabel, errorText, isNotImplemented, runNote } from './page-format';

/*
 * RUNS — the loop's history from `loops.runs.list`, one row per firing
 * (fired, skipped or failed to launch). The `triggered_by` edges still exist
 * and still show under connections; this table adds what edges cannot carry:
 * the outcome, the duration, and why a firing was skipped.
 *
 * A row's session opens the session's own tab (transcript / terminal) through
 * the panel's `onOpenEntity`, the same door every entity link uses.
 */

const PAGE = 20;
/** While a row is running, page one is re-read this often (visible tab only), so it settles on screen. */
export const RUNNING_POLL_MS = 15_000;

type Load =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; text: string; unsupported: boolean };

export function LoopRuns({
  loopId,
  port,
  canControl,
  epoch,
  onOpenEntity,
  onChanged,
}: {
  loopId: string;
  port: LoopPagePort;
  canControl: boolean;
  /**
   * Re-read page one when this changes: the header's Run now bumps it, and the
   * loop's own firing facts (last run, run count) are part of it, so a
   * scheduled firing shows up without a remount.
   */
  epoch: number | string;
  onOpenEntity?: (id: string) => void;
  /** A run was stopped: the header re-reads the loop. */
  onChanged?: () => void;
}) {
  const now = useNow();
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [more, setMore] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ runId: string; text: string } | null>(null);

  // Only the latest read may write: a slow answer for an earlier read (or another loop) is dropped.
  const seq = useRef(0);

  // Another loop starts empty, so its table never shows the previous loop's runs.
  useEffect(() => {
    setRuns([]); setCursor(null); setLoad({ phase: 'loading' }); setRowError(null);
  }, [loopId]);

  const first = useCallback(async () => {
    const mine = ++seq.current;
    setLoad({ phase: 'loading' });
    try {
      const page = await port.runsList(loopId, { limit: PAGE });
      if (mine !== seq.current) return;
      setRuns(page.items); setCursor(page.nextCursor); setLoad({ phase: 'ready' });
    } catch (failure) {
      if (mine !== seq.current) return;
      setLoad({
        phase: 'error',
        unsupported: isNotImplemented(failure),
        text: isNotImplemented(failure)
          ? 'Run history is not available on this server yet (loops.runs.list answered 501).'
          : errorText(failure, 'The run history could not be loaded.'),
      });
    }
  }, [port, loopId]);

  useEffect(() => { void first(); }, [first, epoch]);

  // A running row settles on screen: page one is re-read while one is live and the tab is visible.
  const live = runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void first(); }, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [live, first]);

  const next = async () => {
    if (!cursor || more) return;
    // A page-one read started meanwhile owns the list; this older page must not land on it.
    const mine = seq.current;
    setMore(true);
    try {
      const page = await port.runsList(loopId, { limit: PAGE, cursor });
      if (mine !== seq.current) return;
      setRuns((prev) => [...prev, ...page.items.filter((r) => !prev.some((p) => p.id === r.id))]);
      setCursor(page.nextCursor);
    } catch (failure) {
      setRowError({ runId: '', text: errorText(failure, 'The next page could not be loaded.') });
    } finally {
      setMore(false);
    }
  };

  const stop = async (run: LoopRun) => {
    if (stopping) return;
    setStopping(run.id); setRowError(null);
    try {
      const { run: settled } = await port.runsStop(run.id);
      setRuns((prev) => prev.map((r) => (r.id === settled.id ? settled : r)));
      onChanged?.();
    } catch (failure) {
      setRowError({ runId: run.id, text: errorText(failure, 'Stop was refused. The run is still going.') });
    } finally {
      setStopping(null);
    }
  };

  if (load.phase === 'loading' && runs.length === 0) {
    return <p className="loop-page__hint" role="status" data-testid="loop-runs-loading">Loading runs…</p>;
  }
  if (load.phase === 'error') {
    return (
      <div className="loop-page__runs-error" data-testid="loop-runs-error">
        <p role="alert" className={load.unsupported ? 'loop-page__hint' : 'loop-page__error'}>{load.text}</p>
        {load.unsupported ? null : <button type="button" className="pn-btn" onClick={() => void first()}>Retry</button>}
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="loop-page__hint" data-testid="loop-runs-empty">
        No runs yet. Each firing — scheduled or Run now, including skipped ones — is recorded here.
      </p>
    );
  }

  return (
    <div className="loop-page__runs" data-testid="loop-runs">
      <table className="loop-runs">
        <thead>
          <tr>
            <th scope="col">Fired</th>
            <th scope="col">Trigger</th>
            <th scope="col">Status</th>
            <th scope="col">Duration</th>
            <th scope="col">Task</th>
            <th scope="col">Session</th>
            <th scope="col">Note</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const status = RUN_STATUS[run.status] ?? { label: run.status, tone: 'idle' as const };
            const running = run.status === 'running';
            const note = rowError && rowError.runId === run.id ? rowError.text : runNote(run);
            return (
              <tr key={run.id} data-testid="loop-run-row" data-status={run.status}>
                <td title={absTime(run.firedAt)}>{relTime(run.firedAt, now)}</td>
                <td>{run.trigger === 'manual' ? 'Run now' : 'Schedule'}{run.attempt > 1 ? ` · retry ${run.attempt - 1}` : ''}</td>
                <td><Pill tone={status.tone} dot={running ? 'pulse' : undefined}>{status.label}</Pill></td>
                <td>{running ? `${elapsed(run.startedAt ?? run.firedAt, now)} so far` : durationLabel(run.durationMs)}</td>
                <td>
                  {run.taskId ? (
                    <button type="button" className="pn-btn pn-btn--quiet" onClick={() => onOpenEntity?.(run.taskId!)} disabled={!onOpenEntity}>Task</button>
                  ) : '—'}
                </td>
                <td>
                  {run.sessionId ? (
                    <button type="button" className="pn-btn pn-btn--quiet" onClick={() => onOpenEntity?.(run.sessionId!)} disabled={!onOpenEntity}
                      aria-label={`Open the session of the run fired ${absTime(run.firedAt)}`}>
                      Open session
                    </button>
                  ) : '—'}
                </td>
                <td className={rowError?.runId === run.id || run.status === 'failed' ? 'loop-page__error' : undefined}>{note || ''}</td>
                <td>
                  {running ? (canControl ? (
                    <button type="button" className="pn-btn" disabled={stopping !== null} onClick={() => void stop(run)}>
                      {stopping === run.id ? 'Stopping…' : 'Stop'}
                    </button>
                  ) : (
                    <DisabledAction reason={{ cause: 'You cannot stop this run', remedy: 'the server reports canControl: false for you' }} label="Stop">Stop</DisabledAction>
                  )) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rowError && rowError.runId === '' ? <p role="alert" className="loop-page__error">{rowError.text}</p> : null}
      {cursor ? (
        <button type="button" className="pn-btn" disabled={more} onClick={() => void next()}>
          {more ? 'Loading…' : 'Older runs'}
        </button>
      ) : null}
    </div>
  );
}
