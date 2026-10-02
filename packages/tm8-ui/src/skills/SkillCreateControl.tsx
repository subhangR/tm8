import { useState } from 'react';
import type { SkillPort } from './port';
import './skills.css';
export function SkillCreateControl({ spaceId, port, onNotice }: { spaceId: string; port?: SkillPort; onNotice?: (text: string) => void }) {
  const [roots, setRoots] = useState<Awaited<ReturnType<SkillPort['roots']>> | null>(null);
  const [level, setLevel] = useState('project');
  const [provider, setProvider] = useState('agents');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <div className="sk-create">
    {!roots && <button type="button" className="pn-btn pn-btn--primary" disabled={!port || busy} onClick={() => void run(async () => setRoots(await port!.roots(spaceId)))}>New skill</button>}
    {roots && <form className="sk-form" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void run(async () => { await port!.create(spaceId, { provider, level, root: String(data.get('root')), name: String(data.get('name')), description: String(data.get('description')), body: String(data.get('body')) }); setRoots(null); onNotice?.('Skill file created and scanned'); }); }}>
      <div className="sk-form__row">
        <label className="sk-field"><span className="sk-field__label">Level</span><select className="sk-input" value={level} onChange={e => { setLevel(e.target.value); setProvider('agents'); }}><option value="project">Project</option><option value="user">User</option></select></label>
        <label className="sk-field"><span className="sk-field__label">Provider</span><select className="sk-input" value={provider} onChange={e => setProvider(e.target.value)}>{(level === 'project' ? ['agents', 'claude'] : ['agents', 'claude', 'codex', 'hermes']).map(p => <option key={p}>{p}</option>)}</select></label>
      </div>
      <label className="sk-field"><span className="sk-field__label">Root</span><select className="sk-input" name="root" required key={level}>{level === 'project' ? roots.projects.map(p => <option key={p.id} value={p.id}>{p.workingDir}</option>) : roots.homes.map(h => <option key={h}>{h}</option>)}</select></label>
      <label className="sk-field"><span className="sk-field__label">Name</span><input className="sk-input" name="name" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}" placeholder="e.g. code-review" title="Letters, digits, - and _; starts with a letter or digit" /></label>
      <label className="sk-field"><span className="sk-field__label">Description</span><textarea className="sk-input" name="description" rows={2} placeholder="When should a teammate use this skill?" /></label>
      <label className="sk-field"><span className="sk-field__label">Body</span><textarea className="sk-input sk-input--body" name="body" rows={10} placeholder="Instructions, in markdown" /></label>
      <div className="sk-form__actions">
        <button type="button" className="pn-btn" onClick={() => setRoots(null)} disabled={busy}>Cancel</button>
        <button className="pn-btn pn-btn--primary" disabled={busy}>{busy ? 'Creating…' : 'Create SKILL.md'}</button>
      </div>
    </form>}
    {error && <p role="alert" className="sk-error">{error}</p>}
  </div>;
}
