import { useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { Markdown } from '../kit/Markdown';
import { SkillEquipment } from './SkillEquipment';
import type { SkillPort } from './port';
export function SkillBody({ detail, port, onOpenEntity }: { detail: EntityDetail; port?: SkillPort; onOpenEntity?: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (detail.state.kind !== 'skill' || detail.content.kind !== 'skill') return null;
  const state = detail.state;
  const content = detail.content;
  const body = typeof content.content === 'string' ? content.content : '';
  const readError = typeof content.readError === 'string' ? content.readError : '';
  const writable = !['system', 'admin', 'plugin', 'synced', 'session'].includes(state.level);
  const save = async (form: HTMLFormElement) => {
    const data = new FormData(form); setBusy(true); setError('');
    try { await port!.edit(detail.id, { expectedVersion: detail.version, contentHash: state.contentHash, name: String(data.get('name')), description: String(data.get('description')), body: String(data.get('body')) }); setEditing(false); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="pn-body" data-testid="skill-body">
    <p>{state.provider} · {state.level} · {state.root?.kind} {state.root?.ref}</p>
    {state.missing && <p role="status">Missing file: {state.sourcePath}</p>}
    {state.changedOnDisk && <p role="status">Changed on disk — reload or scan before editing.</p>}
    {readError && <p role="alert">Cannot read skill: {readError}</p>}
    {state.sourcePath && <p><code>{state.sourcePath}</code> <button onClick={() => void navigator.clipboard.writeText(state.sourcePath!)}>Copy path</button></p>}
    <p>{state.description}</p>
    <h3>FRONTMATTER</h3><dl>{Object.entries(state.frontmatter).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl>
    <h3>LOADER METADATA</h3><pre>{JSON.stringify(state.loaderMetadata ?? {}, null, 2)}</pre>
    <p>Scripts {state.bundle?.scripts ?? 0} · References {state.bundle?.references ?? 0} · Assets {state.bundle?.assets ?? 0}</p>
    <p>Version {detail.version} · {state.fileMtime ?? 'No file timestamp'}<br /><code>{state.contentHash}</code></p>
    <Markdown source={body} onOpenEntity={onOpenEntity} />
    {port && writable && <button onClick={() => setEditing(!editing)}>Edit skill</button>}
    {editing && <form onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}><label>Name<input name="name" defaultValue={detail.title} required /></label><label>Description<textarea name="description" defaultValue={state.description} /></label><label>Body<textarea name="body" defaultValue={body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')} /></label><button disabled={busy}>Save skill</button></form>}
    {error && <p role="alert">{error}</p>}
    <SkillEquipment detail={detail} port={port} onOpenEntity={onOpenEntity} />
  </div>;
}
