import { useCallback, useEffect, useState } from 'react';
import { CollabError, ToolDefinitionSchema, type EntityDetail, type ToolDefinition, type ToolRun, type ToolView } from '@tm8/contract';
import { Markdown } from '../kit/Markdown';
import { Pill } from '../kit/Pill';
import type { ToolPermissions, ToolPort } from './port';
import { SourceEditor } from './SourceEditor';
import { draftInput, inputFromDraft, InputsEditor } from './InputsEditor';
import { ToolConfig } from './ToolConfig';
import { RunDialog } from './RunDialog';
import { runLabel } from './values';
import './tools.css';
import { useToolSessionOpen } from './context';

const errorText = (failure: unknown) => failure instanceof Error ? failure.message : 'The request could not be completed.';
function DefinitionEditor({ tool, port, onSaved, onCancel }: { tool: ToolView; port: ToolPort; onSaved(): Promise<void>; onCancel(): void }) {
  const [base, setBase] = useState(tool);
  const [definition, setDefinition] = useState(tool.definition);
  const [inputs, setInputs] = useState(() => tool.definition.inputs.map(draftInput));
  const [timeout, setTimeoutValue] = useState(String(tool.definition.timeoutSeconds));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ latest: ToolView; draft: ToolDefinition } | null>(null);
  const [review, setReview] = useState<{ fields: string[]; latest: ToolDefinition } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const field = <K extends keyof ToolDefinition>(key: K, value: ToolDefinition[K]) => setDefinition(previous => ({ ...previous, [key]: value }));
  const save = async (view: ToolView, next: ToolDefinition) => {
    setBusy(true); setError('');
    try { await port.update(view, next); await onSaved(); }
    catch (failure) {
      if (failure instanceof CollabError && failure.code === 'version_conflict') {
        try { setConflict({ latest: await port.get(tool.id), draft: next }); }
        catch (loadFailure) { setError(errorText(loadFailure)); }
      } else setError(errorText(failure));
    } finally { setBusy(false); }
  };
  const rebase = () => {
    if (!conflict) return;
    const merged = { ...conflict.latest.definition };
    const fields: string[] = [];
    for (const key of Object.keys(merged) as (keyof ToolDefinition)[]) {
      const changed = JSON.stringify(conflict.draft[key]) !== JSON.stringify(base.definition[key]);
      if (!changed) continue;
      if (JSON.stringify(conflict.latest.definition[key]) !== JSON.stringify(base.definition[key]) && JSON.stringify(conflict.latest.definition[key]) !== JSON.stringify(conflict.draft[key])) fields.push(key);
      Object.assign(merged, { [key]: conflict.draft[key] });
    }
    setBase(conflict.latest); setDefinition(merged); setInputs(merged.inputs.map(draftInput)); setTimeoutValue(String(merged.timeoutSeconds));
    setReview(fields.length ? { fields, latest: conflict.latest.definition } : null); setReviewed(false); setConflict(null);
  };
  return <form className="tool-definition" aria-label="Tool definition" onSubmit={event => { event.preventDefault(); if (busy) return; setError('');
    if (conflict || (review && !reviewed)) return;
    let next: ToolDefinition;
    try { next = ToolDefinitionSchema.parse({ ...definition, inputs: inputs.map(inputFromDraft), timeoutSeconds: Number(timeout) }); }
    catch (failure) { setError(errorText(failure)); return; }
    void save(base, next);
  }}><fieldset disabled={busy}>
    <label className="tool-field">Name<input value={definition.name} onChange={event => field('name', event.target.value)} required pattern="[a-z][a-z0-9-]{1,62}" /></label>
    <label className="tool-field">Description<textarea value={definition.description} onChange={event => field('description', event.target.value)} /></label>
    <label className="tool-field">Runtime<select value={definition.runtime} onChange={event => field('runtime', event.target.value as 'bash' | 'python')}><option value="bash">Bash</option><option value="python">Python</option></select></label>
    <h3>Source</h3><SourceEditor value={definition.source} runtime={definition.runtime} readOnly={busy} onChange={value => field('source', value)} />
    <InputsEditor rows={inputs} onChange={setInputs} />
    <label className="tool-field">Help (Markdown)<textarea rows={5} value={definition.help} onChange={event => field('help', event.target.value)} /></label>
    <label className="tool-field">tm8 API access<select value={definition.tm8Access} onChange={event => field('tm8Access', event.target.value as ToolDefinition['tm8Access'])}><option value="none">None</option><option value="read">Read</option><option value="write">Write</option></select></label>
    <label className="tool-field">Timeout (seconds)<input type="number" min={1} step={1} value={timeout} onChange={event => setTimeoutValue(event.target.value)} required /></label>
    {error && <p role="alert">{error}</p>}
    {conflict && <section aria-label="Version conflict"><p role="alert">This tool changed after you loaded version {base.version}. Your draft has not been saved. Review version {conflict.latest.version}, then rebase your changes or explicitly overwrite it.</p>
      <details><summary>Latest saved definition</summary><pre>{JSON.stringify(conflict.latest.definition, null, 2)}</pre></details>
      <div className="tool-actions"><button type="button" className="pn-btn" onClick={rebase}>Rebase draft</button><button type="button" className="pn-btn" onClick={() => void save(conflict.latest, conflict.draft)}>Overwrite with my draft</button></div>
    </section>}
    {review && <section aria-label="Review rebased fields"><p>Both versions changed: {review.fields.join(', ')}. Your draft values are in the editor. Compare them with the latest saved values before saving.</p><details><summary>Latest conflicting values</summary><pre>{JSON.stringify(Object.fromEntries(review.fields.map(key => [key, review.latest[key as keyof ToolDefinition]])), null, 2)}</pre></details><label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> I reviewed and merged the conflicting fields.</label></section>}
    <div className="tool-actions"><button type="button" className="pn-btn" onClick={onCancel}>Discard changes</button><button className="pn-btn pn-btn--primary" disabled={!!conflict || (!!review && !reviewed)}>{busy ? 'Saving…' : 'Save tool'}</button></div>
  </fieldset></form>;
}

export function ToolBody({ detail, port, onOpenSession: explicitOpen }: { detail: EntityDetail; port?: ToolPort; onOpenSession?: (id: string) => void }) {
  const contextOpen = useToolSessionOpen();
  const onOpenSession = explicitOpen ?? contextOpen;
  const [loaded, setLoaded] = useState<{ tool: ToolView; permissions: ToolPermissions } | null>(null);
  const [history, setHistory] = useState<ToolRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const refresh = useCallback(async () => {
    if (!port) return;
    const [tool, permissions] = await Promise.all([port.get(detail.id), port.permissions(detail.id)]);
    setLoaded({ tool, permissions }); setError('');
  }, [port, detail.id]);
  useEffect(() => { let active = true; setLoaded(null); setError(''); setEditing(false); setRunning(false);
    if (port) void Promise.all([port.get(detail.id), port.permissions(detail.id)]).then(([tool, permissions]) => { if (active) setLoaded({ tool, permissions }); }, failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [port, detail.id]);
  useEffect(() => {
    if (!loaded || editing || running || loaded.tool.version === detail.version) return;
    void refresh().catch(failure => setError(errorText(failure)));
  }, [detail.version, loaded?.tool.version, editing, running, refresh]);
  const loadHistory = useCallback(async (next?: string) => {
    if (!port) return; setLoadingMore(true); setHistoryError('');
    try { const page = await port.history(detail.id, next); setHistory(previous => next ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor); }
    catch (failure) { setHistoryError(errorText(failure)); }
    finally { setLoadingMore(false); }
  }, [port, detail.id]);
  useEffect(() => { let active = true; setHistory([]); setCursor(null); setHistoryError('');
    if (port) void port.history(detail.id).then(page => { if (active) { setHistory(page.items); setCursor(page.nextCursor); } }, failure => { if (active) setHistoryError(errorText(failure)); });
    return () => { active = false; };
  }, [port, detail.id, detail.activityAt]);
  if (!port) return <p role="status">Tools are unavailable on this connection.</p>;
  if (!loaded) return <div className="pn-body tool-body">{error ? <p role="alert">{error} <button className="pn-btn" onClick={() => void refresh().catch(failure => setError(errorText(failure)))}>Retry</button></p> : <p role="status">Loading tool…</p>}</div>;
  const { tool, permissions } = loaded;
  return <div className="pn-body tool-body" data-testid="tool-body">
    <header><h2>{tool.definition.name}</h2><p>{tool.definition.description}</p><div className="tool-actions"><Pill>{tool.definition.runtime === 'bash' ? 'Bash' : 'Python'}</Pill><span>Version {tool.version}</span>
      <button type="button" className="pn-btn" disabled={!permissions.edit || editing} title={!permissions.edit ? 'You do not have permission to edit this tool.' : undefined} onClick={() => setEditing(true)}>Edit tool</button>
      <button type="button" className="pn-btn pn-btn--primary" disabled={!permissions.run || !onOpenSession || editing} title={editing ? 'Save or discard changes to run.' : !onOpenSession ? 'A terminal host is unavailable in this view.' : !permissions.run ? 'You do not have permission to run this tool.' : undefined} onClick={() => setRunning(true)}>Run</button>
    </div></header>
    {error && <p role="alert">{error}</p>}
    {editing && detail.version > tool.version && <p role="status">This tool changed while you were editing. Your draft is preserved and saves against the version you loaded.</p>}
    {editing ? <DefinitionEditor tool={tool} port={port} onCancel={() => setEditing(false)} onSaved={async () => { await refresh(); setEditing(false); }} /> : <>
      <section aria-label="Source"><h3>Source</h3><SourceEditor readOnly value={tool.definition.source} runtime={tool.definition.runtime} onChange={() => {}} /></section>
      <section aria-label="Inputs"><h3>Inputs</h3><div className="tool-table-scroll"><table className="tool-inputs"><thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>{tool.definition.inputs.map(input => <tr key={input.name}><td>{input.name}</td><td>{input.type}</td><td>{input.required ? 'Yes' : 'No'}</td><td>{input.description}</td></tr>)}</tbody></table></div>{!tool.definition.inputs.length && <p>No inputs declared.</p>}</section>
      <ToolConfig tool={tool} permissions={permissions} port={port} refresh={refresh} />
      {tool.definition.help && <section aria-label="Help"><h3>Help</h3><Markdown source={tool.definition.help} /></section>}
    </>}
    <section aria-label="Run history"><h3>Run history</h3>{historyError && <p role="alert">{historyError} <button className="pn-btn" onClick={() => void loadHistory()}>Retry history</button></p>}
      {!history.length && !historyError && <p>No runs yet.</p>}<ol className="tool-runs">{history.map(run => <li key={run.id}><button type="button" className="pn-btn" disabled={!onOpenSession} onClick={() => onOpenSession?.(run.id)}>{run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Run'} · v{run.toolVersion}</button><Pill tone={run.state === 'running' ? 'run' : run.state !== 'exited' || run.exitCode !== 0 ? 'block' : 'idle'}>{runLabel(run)}</Pill></li>)}</ol>
      {cursor && <button type="button" className="pn-btn" disabled={loadingMore} onClick={() => void loadHistory(cursor)}>More runs</button>}
    </section>
    {running && onOpenSession && <RunDialog tool={tool} port={port} onClose={() => { setRunning(false); void loadHistory(); }} onOpenSession={onOpenSession} />}
  </div>;
}
