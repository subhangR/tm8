import { useCallback, useEffect, useRef, useState } from 'react';
import { TOOL_MAX_OUTPUT_BYTES, type ToolRun } from '@tm8/contract';
import { Pill } from '../kit/Pill';
import { Timestamp } from '../kit/Timestamp';
import { useDismissable } from '../panels/useDismissable';
import type { ToolPort } from './port';
import { ToolErrorAlert, toolErrorOf, type ToolErrorView } from './errors';
import { runDuration, runInvoker, runLabel, runTone } from './values';

const inputText = (value: unknown) => value && typeof value === 'object' && 'secret' in value
  ? (value as { secret: string }).secret === 'passed' ? 'secret passed for this run' : 'saved secret'
  : JSON.stringify(value);

/**
 * One run's saved output: the redacted tail `tools.runs.get` returns, read
 * fresh when the drawer opens rather than trusted from the history page.
 */
export function OutputDrawer({ sessionId, port, onClose, onOpenSession }: { sessionId: string; port: ToolPort; onClose(): void; onOpenSession?: (id: string) => void }) {
  const [run, setRun] = useState<ToolRun | null>(null);
  const [error, setError] = useState<ToolErrorView | null>(null);
  const [loading, setLoading] = useState(true);
  const drawer = useRef<HTMLElement>(null);
  useDismissable(true, drawer, onClose);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setRun(await port.runGet(sessionId)); } catch (failure) { setError(toolErrorOf(failure, 'load')); } finally { setLoading(false); }
  }, [port, sessionId]);
  useEffect(() => { setRun(null); void load(); }, [load]);
  useEffect(() => { drawer.current?.focus(); }, []);
  const invoker = run ? runInvoker(run) : null;
  const inputs = run ? Object.entries(run.inputs) : [];
  return <div className="tool-drawer-backdrop"><aside ref={drawer} tabIndex={-1} className="tool-drawer" role="dialog" aria-modal="true" aria-label="Run output">
    <header className="tool-drawer__head"><h2>Run output</h2>
      <div className="tool-actions">
        <button type="button" className="pn-btn" disabled={loading} onClick={() => void load()}>Refresh</button>
        {onOpenSession && <button type="button" className="pn-btn" onClick={() => { onOpenSession(sessionId); onClose(); }}>Open terminal</button>}
        <button type="button" className="pn-btn" onClick={onClose}>Close</button>
      </div>
    </header>
    <ToolErrorAlert error={error} />
    {loading && !run && <p role="status">Loading output…</p>}
    {run && <>
      <dl className="tool-drawer__facts">
        <dt>Result</dt><dd><Pill tone={runTone(run)}>{runLabel(run)}</Pill></dd>
        <dt>Started</dt><dd>{run.startedAt ? <Timestamp at={run.startedAt} /> : '—'}</dd>
        <dt>Duration</dt><dd>{runDuration(run)}</dd>
        <dt>Invoker</dt><dd>{invoker!.label}</dd>
        <dt>Version</dt><dd>v{run.toolVersion}</dd>
        <dt>Source sha256</dt><dd><code className="tool-sha">{run.sourceSha256}</code></dd>
        <dt>Keep open</dt><dd>{run.keepOpen ? 'Yes' : 'No'}</dd>
      </dl>
      {inputs.length > 0 && <><h3>Inputs</h3><ul className="tool-drawer__inputs">{inputs.map(([name, value]) => <li key={name}><code>{name}</code> {inputText(value)}</li>)}</ul></>}
      <h3>Saved output</h3>
      <p className="tool-note">The last {Math.round(TOOL_MAX_OUTPUT_BYTES / 1024)} KiB, with secrets redacted. The terminal shows everything while its shell is open.</p>
      {run.outputTail
        ? <pre className="tool-output" tabIndex={0} aria-label="Saved output">{run.outputTail}</pre>
        : <p role="status">{run.state === 'running' ? 'This run is still going. Its output is saved when it exits; open the terminal to watch it live.' : 'This run saved no output.'}</p>}
    </>}
  </aside></div>;
}
