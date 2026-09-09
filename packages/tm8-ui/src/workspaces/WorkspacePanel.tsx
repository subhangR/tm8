import { useEffect, useRef, useState } from 'react';
import type { UserWorkspace } from '@tm8/contract';
import { PrivateTerminal } from './PrivateTerminal';
import { workspaceApi } from './api';
import { GithubSignIn } from './GithubSignIn';
import { useDeployment } from './DeploymentGate';
import './workspace.css';

interface Resource { id: string; name: string }
interface GitStatus { status: string; branch: string; remotes: string }
export function WorkspacePanel({ onGraphChanged }: { onGraphChanged?: () => void }) {
  const deployment = useDeployment();
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [workspace, setWorkspace] = useState<UserWorkspace | null>(null);
  const [spaces, setSpaces] = useState<Resource[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [projects, setProjects] = useState<Resource[]>([]);
  const [projectId, setProjectId] = useState('');
  const [git, setGit] = useState<GitStatus | null>(null);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [remote, setRemote] = useState('tm8');
  const [source, setSource] = useState<'init' | 'clone' | 'import'>('init');
  const mutation = useRef(crypto.randomUUID());
  const [filePath, setFilePath] = useState('README.md');
  const [fileContent, setFileContent] = useState('');
  const [files, setFiles] = useState<{ name: string; kind: string }[]>([]);
  useEffect(() => {
    void workspaceApi<{ workspaceIsolation: boolean }>('/v2/deployment/capabilities').then(value => {
      setAvailable(value.workspaceIsolation);
      if (value.workspaceIsolation) void workspaceApi<UserWorkspace | null>('/v2/workspaces/me').then(value => { setWorkspace(value); if (!value || value.state !== 'ready') setOpen(true); }).catch(error => setMessage(error.message));
    }).catch(() => undefined);
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage(''); try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Workspace operation failed'); } finally { setBusy(false); }
  }
  async function refreshSpaces() { const rows = await workspaceApi<Resource[]>('/v2/spaces'); setSpaces(rows); setSpaceId(current => current || rows[0]?.id || ''); }
  async function refreshProjects() { if (spaceId) setProjects(await workspaceApi<Resource[]>(`/v2/projects?spaceId=${spaceId}`)); }
  async function refreshGit() { if (projectId) setGit(await workspaceApi<GitStatus>('/v2/workspaces/git', { projectId, action: 'status' })); }
  useEffect(() => { if (open) void run(refreshSpaces); }, [open]);
  useEffect(() => { setProjectId(''); setGit(null); setTerminal(null); if (spaceId) void run(refreshProjects); }, [spaceId]);
  useEffect(() => { setGit(null); setFiles([]); setTerminal(null); if (projectId) void run(refreshGit); }, [projectId]);
  if (!available) return null;
  return <>
    <button className="workspace-launcher" onClick={() => setOpen(true)}>My workspace</button>
    {open && <section className="workspace-panel" aria-label="My workspace">
      <header><div><h1>My workspace</h1><p>{workspace ? `${workspace.state} · ${workspace.limits.cpus} CPUs · ${workspace.limits.memoryMiB} MiB` : 'Create your private Ubuntu workspace to begin.'}</p></div><button onClick={() => setOpen(false)}>Back to spaces</button></header>
      <p role="status" aria-live="polite">{busy ? 'Working…' : message}</p>
      <GithubSignIn link />
      {workspace?.state !== 'ready' && <button disabled={busy || workspace?.state === 'suspended'} onClick={() => void run(async () => { setWorkspace(await workspaceApi('/v2/workspaces/me/ensure', {})); })}>{workspace ? 'Retry workspace setup' : 'Create workspace'}</button>}
      {workspace?.state === 'ready' && <>
        <div className="workspace-grid"><aside>
          <h2>Spaces</h2><label>Active space<select value={spaceId} onChange={event => setSpaceId(event.target.value)}><option value="">Choose a space</option>{spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
          <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const name = new FormData(form).get('name'); void run(async () => { await workspaceApi('/v2/spaces', { name, clientMutationId: crypto.randomUUID() }); form.reset(); await refreshSpaces(); onGraphChanged?.(); }); }}><label>New space<input name="name" required maxLength={200} /></label><button disabled={busy}>Create space</button></form>
          <h2>Projects</h2><label>Active project<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Choose a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          {deployment?.distributedSystemFlag && spaceId && <form onSubmit={event => { event.preventDefault(); const email = new FormData(event.currentTarget).get('email'); void run(async () => {
            const invitation = await workspaceApi<{ url: string }>('/v2/workspaces/invitations', { spaceId, email, clientMutationId: crypto.randomUUID() }); setMessage(`Invitation: ${invitation.url}`);
          }); }}><label>Invite to this space<input name="email" type="email" required /></label><button disabled={busy}>Create invitation link</button><small>The recipient must use this machine. A space administrator can create invitations.</small></form>}
          <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); void run(async () => { const project = await workspaceApi<{ projectId: string }>('/v2/workspaces/projects', { name: data.get('name'), spaceId, source: source === 'init' ? { kind: 'init' } : source === 'clone' ? { kind: 'clone', url: data.get('source') } : { kind: 'import', relativePath: data.get('source') }, clientMutationId: mutation.current }); mutation.current = crypto.randomUUID(); form.reset(); await refreshProjects(); setProjectId(project.projectId); onGraphChanged?.(); }); }}>
            <label>Project name<input name="name" required maxLength={200} onChange={() => { mutation.current = crypto.randomUUID(); }} /></label><label>Start from<select value={source} onChange={event => { setSource(event.target.value as typeof source); mutation.current = crypto.randomUUID(); }}><option value="init">New Git repository</option><option value="clone">Clone from GitHub</option><option value="import">Import a workspace folder</option></select></label>
            {source !== 'init' && <label>{source === 'clone' ? 'HTTPS GitHub URL' : 'Path relative to your workspace home'}<input name="source" required onChange={() => { mutation.current = crypto.randomUUID(); }} /></label>}<button disabled={busy || !spaceId}>Create project</button>
          </form>
        </aside><div>
          {projectId ? <>
            <h2>Git</h2><p>Your checkout is private. Push commits to share them with this space.</p>
            <label>Remote<select value={remote} onChange={event => setRemote(event.target.value)}><option value="tm8">tm8 · shared space repository</option><option value="origin">origin · GitHub</option></select></label>
            <div>{(['fetch', 'pull', 'push'] as const).map(action => <button key={action} disabled={busy} onClick={() => void run(async () => { await workspaceApi('/v2/workspaces/git', { projectId, action, remote }); await refreshGit(); setMessage(`${action} completed`); })}>{action[0].toUpperCase() + action.slice(1)}</button>)}<button disabled={busy} onClick={() => void run(refreshGit)}>Refresh status</button></div>
            <pre>{git ? `${git.status}\n${git.remotes}` : 'Loading Git status…'}</pre>
            <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const message = new FormData(form).get('message'); void run(async () => { await workspaceApi(`/v2/workspaces/projects/${projectId}/git/commit`, { message }); form.reset(); await refreshGit(); }); }}><label>Commit message<input name="message" required maxLength={4096} /></label><button disabled={busy}>Commit all changes</button></form>
            <form onSubmit={event => { event.preventDefault(); const url = new FormData(event.currentTarget).get('url'); void run(async () => { await workspaceApi(`/v2/workspaces/projects/${projectId}/git/connect`, { url }); await refreshGit(); }); }}><label>GitHub repository URL<input name="url" type="url" placeholder="https://github.com/owner/repository.git" required /></label><button disabled={busy}>Connect GitHub remote</button></form>
            <h2>Files</h2><button disabled={busy} onClick={() => void run(async () => { const data = await workspaceApi<{ entries: typeof files }>(`/v2/workspaces/projects/${projectId}/files`); setFiles(data.entries); })}>List project files</button>
            <ul>{files.map(file => <li key={file.name}>{file.name}{file.kind === 'directory' ? '/' : ''}</li>)}</ul>
            <label>Project-relative file path<input value={filePath} onChange={event => setFilePath(event.target.value)} /></label>
            <button disabled={busy} onClick={() => void run(async () => { const data = await workspaceApi<{ content: string }>(`/v2/workspaces/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`); setFileContent(new TextDecoder().decode(Uint8Array.from(atob(data.content), char => char.charCodeAt(0)))); })}>Read file</button>
            <label>File content<textarea rows={10} value={fileContent} onChange={event => setFileContent(event.target.value)} /></label>
            <button disabled={busy} onClick={() => void run(async () => { const bytes = new TextEncoder().encode(fileContent); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); await workspaceApi(`/v2/workspaces/projects/${projectId}/files/content`, { path: filePath, content: btoa(binary) }); await refreshGit(); setMessage('File saved in your private checkout'); })}>Save file</button>
          </> : <p>Choose a project or create a new Git repository.</p>}
          <h2>Terminal</h2><button disabled={busy} onClick={() => void run(async () => { const session = await workspaceApi<{ socketPath: string }>('/v2/workspaces/terminals', projectId ? { projectId } : {}); setTerminal(session.socketPath); })}>Open terminal</button>
          {terminal && <PrivateTerminal socketPath={terminal} />}
          <h2>GitHub credentials</h2><p>The token is kept in your private workspace. Use a token with access to the repositories you want to synchronize.</p>
          <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const token = new FormData(form).get('token'); form.reset(); void run(async () => { const result = await workspaceApi<{ login: string }>('/v2/workspaces/credentials/github', { token }); setMessage(`GitHub connected as ${result.login}`); }); }}><label>GitHub token<input name="token" type="password" autoComplete="off" required /></label><button disabled={busy}>Connect GitHub account</button><button type="button" disabled={busy} onClick={() => void run(async () => { await workspaceApi('/v2/workspaces/credentials/github', { token: null }); setMessage('GitHub credential removed'); })}>Remove credential</button></form>
          {projectId && <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(async () => { await workspaceApi(`/v2/workspaces/projects/${projectId}/github`, { name: data.get('name'), private: data.get('private') === 'on' }); await refreshGit(); setMessage('GitHub repository created and connected'); }); }}><label>New GitHub repository name<input name="name" required pattern="[A-Za-z0-9_.-]{1,100}" /></label><label><input name="private" type="checkbox" defaultChecked /> Private repository</label><button disabled={busy}>Create GitHub repository</button></form>}
        </div></div>
      </>}
    </section>}
  </>;
}
