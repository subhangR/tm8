import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolRun } from '@tm8/contract';
import { Pill } from '../kit/Pill';
import { Timestamp } from '../kit/Timestamp';
import { absTime, useNow } from '../kit/time';
import type { ToolPort } from './port';
import { toolErrorOf, type ToolErrorView } from './errors';
import { ToolErrorAlert } from './ToolErrorAlert';
import { runDuration, runInvoker, runLabel, runTone, shortSha } from './values';
import { runVersionOf } from './version-field';

/** A run's outcome lands when its process exits; nothing tells the tool page, so a running row asks. */
export const RUN_POLL_MS = 3000;

/** Newest-first run history (`tools.runs.list`), paged, with running rows kept current. */
export function useToolRuns(port: ToolPort | undefined, toolId: string, refreshKey: unknown) {
  const [items, setItems] = useState<ToolRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ToolErrorView | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (next?: string) => {
    if (!port) return;
    const mine = next ? generation.current : ++generation.current;
    setLoadingMore(true); setError(null);
    try {
      const page = await port.history(toolId, next);
      if (mine !== generation.current) return;
      setItems(previous => next ? [...previous, ...page.items.filter(run => !previous.some(seen => seen.id === run.id))] : page.items);
      setCursor(page.nextCursor);
    } catch (failure) { if (mine === generation.current) setError(toolErrorOf(failure, 'load')); }
    finally { if (mine === generation.current) setLoadingMore(false); }
  }, [port, toolId]);
  useEffect(() => { setItems([]); setCursor(null); void load(); }, [load, refreshKey]);
  const running = items.filter(run => run.state === 'running').map(run => run.id).join(',');
  useEffect(() => {
    if (!port || !running) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      for (const id of running.split(',')) {
        void port.runGet(id).then(run => setItems(previous => previous.map(item => item.id === run.id ? { ...item, ...run } : item)), () => {});
      }
    }, RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [port, running]);
  return { items, cursor, error, loadingMore, reload: () => load(), more: () => cursor ? load(cursor) : Promise.resolve() };
}
export type ToolRuns = ReturnType<typeof useToolRuns>;

export function RunHistory({ runs, onOpenSession, onOutput, onVersion, versionNote }: {
  runs: ToolRuns;
  onOpenSession?: (id: string) => void;
  onOutput(run: ToolRun): void;
  /** Open this run's pinned version in the Versions section. */
  onVersion?(run: ToolRun): void;
  /** The folded/unstored hint for a run's version, from versions already loaded. */
  versionNote?(run: ToolRun): string | null;
}) {
  const now = useNow();
  const { items, cursor, error, loadingMore } = runs;
  return <section aria-label="Run history"><h3>Run history</h3>
    <ToolErrorAlert error={error}> <button type="button" className="pn-btn" onClick={() => void runs.reload()}>Retry history</button></ToolErrorAlert>
    {!items.length && !error && (loadingMore ? <p role="status">Loading runs…</p> : <p>No runs yet.</p>)}
    {items.length > 0 && <div className="tool-table-scroll"><table className="tool-inputs tool-runs-table">
      <thead><tr><th>Started</th><th>Duration</th><th>Result</th><th>Invoker</th><th>Version</th><th>Keep open</th><th><span className="tool-sr">Actions</span></th></tr></thead>
      <tbody>{items.map(run => {
        const invoker = runInvoker(run), note = versionNote?.(run) ?? null, version = runVersionOf(run);
        const named = run.startedAt ? `the run started ${absTime(run.startedAt)}` : `run ${run.id}`;
        return <tr key={run.id} data-run-id={run.id}>
          <td>{run.startedAt ? <Timestamp at={run.startedAt} /> : '—'}</td>
          <td>{runDuration(run, now)}</td>
          <td><Pill tone={runTone(run)}>{runLabel(run)}</Pill></td>
          <td data-invoker={invoker.kind}>{invoker.label}</td>
          <td className="tool-run-version">
            {onVersion ? <button type="button" className="tool-link" title={`Show version ${version} in Versions`} onClick={() => onVersion(run)}>v{version}</button> : `v${version}`}
            {' '}<code title={`source sha256 ${run.sourceSha256}`}>{shortSha(run.sourceSha256)}</code>
            {note && <small className="tool-run-version__note">{note}</small>}
          </td>
          <td>{run.keepOpen ? 'Yes' : 'No'}</td>
          <td><div className="tool-actions">
            <button type="button" className="pn-btn" disabled={!onOpenSession} title={!onOpenSession ? 'A terminal host is unavailable in this view.' : undefined} aria-label={`Open terminal for ${named}`} onClick={() => onOpenSession?.(run.id)}>Open terminal</button>
            <button type="button" className="pn-btn" aria-label={`Output of ${named}`} onClick={() => onOutput(run)}>Output</button>
          </div></td>
        </tr>;
      })}</tbody>
    </table></div>}
    {cursor && <button type="button" className="pn-btn" disabled={loadingMore} onClick={() => void runs.more()}>{loadingMore ? 'Loading…' : 'More runs'}</button>}
  </section>;
}
