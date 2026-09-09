import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { NewSpaceProjectDialogProps } from '../projects/NewSpaceProjectDialog';
import { workspaceApi } from './api';

/** The existing Space entry point uses the same private Git project API. */
export function NewWorkspaceSpaceDialog(props: NewSpaceProjectDialogProps) {
  const [name, setName] = useState(''), [project, setProject] = useState('');
  const [source, setSource] = useState<'init' | 'clone'>('init'), [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const ids = useRef({ space: crypto.randomUUID(), project: crypto.randomUUID() });
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    if (props.open) { setName(''); setProject(''); setUrl(''); setSource('init'); setLocked(false); setError(''); ids.current = { space: crypto.randomUUID(), project: crypto.randomUUID() }; }
  }, [props.open]);
  if (!props.open) return null;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setLocked(true);
    try {
      if (project.trim()) await workspaceApi('/v2/workspaces/me/ensure', {});
      const { space } = await props.port.createSpace({ name: name.trim(), visibility: 'private', clientMutationId: ids.current.space });
      if (project.trim()) await workspaceApi('/v2/workspaces/projects', { spaceId: space.id, name: project.trim(),
        source: source === 'init' ? { kind: 'init' } : { kind: 'clone', url: url.trim() }, clientMutationId: ids.current.project });
      props.onCreated(space);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to create the space'); }
    finally { setBusy(false); }
  }
  return <div className="project-onboard__backdrop" onKeyDown={event => { if (event.key === 'Escape' && !busy) props.onDismiss(); }}>
    <section className="project-onboard" role="dialog" aria-modal="true" aria-label="New space">
      <h2>New space</h2><form className="project-onboard__form" onSubmit={event => void submit(event)}>
        <fieldset disabled={locked}><label>Space name<input autoFocus required value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label>
          <label>Project name (optional)<input value={project} maxLength={200} onChange={event => setProject(event.target.value)} /></label>
          {project && <><label>Start from<select value={source} onChange={event => setSource(event.target.value as typeof source)}><option value="init">New Git repository</option><option value="clone">Clone from GitHub</option></select></label>
            {source === 'clone' && <label>HTTPS GitHub URL<input type="url" required value={url} onChange={event => setUrl(event.target.value)} /></label>}
            <p>The project opens in your private workspace. Push commits to share them with space members.</p></>}
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={props.onDismiss}>Cancel</button><button disabled={busy}>{busy ? 'Creating…' : locked ? 'Retry' : 'Create space'}</button></footer>
      </form>
    </section>
  </div>;
}
