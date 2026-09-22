import { useState } from 'react';
import type { SkillPort } from './port';
export function SkillCreateControl({ spaceId, port, onNotice }: { spaceId: string; port?: SkillPort; onNotice?: (text: string) => void }) {
  const [roots, setRoots] = useState<Awaited<ReturnType<SkillPort['roots']>> | null>(null);
  const [level, setLevel] = useState('project');
  const [provider, setProvider] = useState('agents');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <div><button disabled={!port || busy} onClick={() => void run(async () => setRoots(await port!.roots(spaceId)))}>New skill</button>
    {roots && <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void run(async () => { await port!.create(spaceId, { provider, level, root: String(data.get('root')), name: String(data.get('name')), description: String(data.get('description')), body: String(data.get('body')) }); setRoots(null); onNotice?.('Skill file created and scanned'); }); }}>
      <label>Level<select value={level} onChange={e => { setLevel(e.target.value); setProvider('agents'); }}><option value="project">Project</option><option value="user">User</option></select></label>
      <label>Provider<select value={provider} onChange={e => setProvider(e.target.value)}>{(level === 'project' ? ['agents', 'claude'] : ['agents', 'claude', 'codex', 'hermes']).map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Root<select name="root" required key={level}>{level === 'project' ? roots.projects.map(p => <option key={p.id} value={p.id}>{p.workingDir}</option>) : roots.homes.map(h => <option key={h}>{h}</option>)}</select></label>
      <label>Name<input name="name" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}" /></label>
      <label>Description<textarea name="description" /></label><label>Body<textarea name="body" /></label>
      <button disabled={busy}>Create SKILL.md</button><button type="button" onClick={() => setRoots(null)}>Cancel</button>
    </form>}{error && <p role="alert">{error}</p>}
  </div>;
}
