import { useCallback, useEffect, useRef, useState } from 'react';
import { CollabError, type EntityDetail, type ToolDefinition, type ToolLastRun, type ToolRun, type ToolView } from '@tm8/contract';
import { Markdown } from '../kit/Markdown';
import { Pill } from '../kit/Pill';
import type { ToolPermissions, ToolPort } from './port';
import { SourceEditor } from './SourceEditor';
import { DefinitionForm, definitionOfDraft, draftOfDefinition } from './DefinitionForm';
import { definitionProblemOf, type DefinitionProblem } from './errors';
import { ToolConfig } from './ToolConfig';
import { RunDialog } from './RunDialog';
import { RunHistory, useToolRuns } from './RunHistory';
import { OutputDrawer } from './OutputDrawer';
import { LastRunChip } from './LastRunChip';
import { Versions, useToolVersions, type VersionFocus } from './Versions';
import { versionNote } from './versions-model';
import { runVersionOf, toolVersionOf } from './version-field';
import './tools.css';
import { useToolSessionOpen } from './context';

const errorText = (failure: unknown) => failure instanceof Error ? failure.message : 'The request could not be completed.';
function DefinitionEditor({ tool, port, onSaved, onCancel }: { tool: ToolView; port: ToolPort; onSaved(): Promise<void>; onCancel(): void }) {
  const [base, setBase] = useState(tool);
  const [draft, setDraft] = useState(() => draftOfDefinition(tool.definition));
  const [problem, setProblem] = useState<DefinitionProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ latest: ToolView; draft: ToolDefinition } | null>(null);
  const [review, setReview] = useState<{ fields: string[]; latest: ToolDefinition } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const save = async (view: ToolView, next: ToolDefinition) => {
    setBusy(true); setProblem(null);
    try { await port.update(view, next); await onSaved(); }
    catch (failure) {
      if (failure instanceof CollabError && failure.code === 'version_conflict') {
        try { setConflict({ latest: await port.get(tool.id), draft: next }); }
        catch (loadFailure) { setProblem(definitionProblemOf(loadFailure)); }
      } else setProblem(definitionProblemOf(failure));
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
    setBase(conflict.latest); setDraft(draftOfDefinition(merged));
    setReview(fields.length ? { fields, latest: conflict.latest.definition } : null); setReviewed(false); setConflict(null);
  };
  const marked = problem && !problem.message && Object.keys(problem.fields).length > 0;
  return <form className="tool-definition" aria-label="Tool definition" noValidate onSubmit={event => { event.preventDefault(); if (busy) return; setProblem(null);
    if (conflict || (review && !reviewed)) return;
    const parsed = definitionOfDraft(draft);
    if ('problem' in parsed) { setProblem(parsed.problem); return; }
    void save(base, parsed.definition);
  }}><fieldset disabled={busy}>
    <DefinitionForm draft={draft} onChange={setDraft} disabled={busy} errors={problem?.fields} />
    {problem?.message && <p role="alert">{problem.message}</p>}
    {marked && <p role="alert">Fix the marked fields, then save again.</p>}
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
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const runs = useToolRuns(port, detail.id, detail.activityAt);
  const versions = useToolVersions(port, detail.id, detail.version);
  const [outputOf, setOutputOf] = useState<string | null>(null);
  const [focus, setFocus] = useState<VersionFocus | null>(null);
  const versionsRef = useRef<HTMLElement>(null);
  const refresh = useCallback(async () => {
    if (!port) return;
    const [tool, permissions] = await Promise.all([port.get(detail.id), port.permissions(detail.id)]);
    setLoaded({ tool, permissions }); setError('');
  }, [port, detail.id]);
  useEffect(() => { let active = true; setLoaded(null); setError(''); setEditing(false); setRunning(false); setOutputOf(null); setFocus(null);
    if (port) void Promise.all([port.get(detail.id), port.permissions(detail.id)]).then(([tool, permissions]) => { if (active) setLoaded({ tool, permissions }); }, failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [port, detail.id]);
  useEffect(() => {
    if (!loaded || editing || running || loaded.tool.version === detail.version) return;
    void refresh().catch(failure => setError(errorText(failure)));
  }, [detail.version, loaded?.tool.version, editing, running, refresh]);
  /** A run's version opens in Versions; a folded or unstored one says so instead of diffing nothing. */
  const openVersion = async (run: ToolRun) => {
    const version = runVersionOf(run);
    const resolution = await versions.ensure(version);
    setFocus({ version, sourceSha256: run.sourceSha256, resolution });
    versionsRef.current?.scrollIntoView?.({ block: 'start' }); versionsRef.current?.focus();
  };
  if (!port) return <p role="status">Tools are unavailable on this connection.</p>;
  if (!loaded) return <div className="pn-body tool-body">{error ? <p role="alert">{error} <button className="pn-btn" onClick={() => void refresh().catch(failure => setError(errorText(failure)))}>Retry</button></p> : <p role="status">Loading tool…</p>}</div>;
  const { tool, permissions } = loaded;
  // The history's newest row is polled while it runs, so it outranks the summary's snapshot of the same run.
  const newest = runs.items[0];
  const lastRun: ToolLastRun | null = newest && (!tool.lastRun || newest.id >= tool.lastRun.sessionId)
    ? { sessionId: newest.id, state: newest.state, exitCode: newest.exitCode, startedAt: newest.startedAt, exitedAt: newest.exitedAt }
    : tool.lastRun ?? null;
  return <div className="pn-body tool-body" data-testid="tool-body">
    <header><h2>{tool.definition.name}</h2><p>{tool.definition.description}</p><div className="tool-actions"><Pill>{tool.definition.runtime === 'bash' ? 'Bash' : 'Python'}</Pill><span>Version {toolVersionOf(tool)}</span>
      <LastRunChip run={lastRun} onOpen={onOpenSession ?? setOutputOf} />
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
    <RunHistory runs={runs} onOpenSession={onOpenSession} onOutput={run => setOutputOf(run.id)} onVersion={run => void openVersion(run)}
      versionNote={run => versionNote(versions.resolve(runVersionOf(run)))} />
    <Versions ref={versionsRef} versions={versions} focus={focus} />
    {outputOf && <OutputDrawer sessionId={outputOf} port={port} onClose={() => setOutputOf(null)} onOpenSession={onOpenSession} />}
    {running && onOpenSession && <RunDialog tool={tool} port={port} onClose={() => { setRunning(false); void runs.reload(); }} onRunError={() => void runs.reload()} onOpenSession={onOpenSession} />}
  </div>;
}
