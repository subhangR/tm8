import { useState } from 'react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import type { SkillPort } from './port';
export function skillScope(row: EntitySummary): string {
  return row.state.kind === 'skill' ? `${row.state.provider} · ${row.state.level} · ${row.state.root?.ref ?? 'space'}` : '';
}
export function SkillEquipment({ detail, port, onOpenEntity }: { detail: EntityDetail; port?: SkillPort; onOpenEntity?: (id: string) => void }) {
  const [choices, setChoices] = useState<EntitySummary[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  if (detail.state.kind !== 'skill' && detail.state.kind !== 'team_member') return null;
  const isSkill = detail.state.kind === 'skill';
  const peers = (isSkill ? detail.connections.incoming : detail.connections.outgoing).filter(g => g.type === 'equips').flatMap(g => g.edges.map(e => isSkill ? e.source : e.target));
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <section className="pn-block" aria-label="Skill equipment">
    <h3>{isSkill ? 'EQUIPPED BY' : 'SKILL EQUIPMENT'}</h3>
    {peers.map(peer => <div key={peer.id}><button onClick={() => onOpenEntity?.(peer.id)}>{peer.title}</button> <small>{skillScope(peer)}</small> {port && <button disabled={busy} onClick={() => void run(() => port.equip(isSkill ? detail.id : peer.id, isSkill ? peer.id : detail.id, false))}>Unequip</button>}</div>)}
    {!peers.length && <p>No equipment yet.</p>}
    {port && <button disabled={busy} onClick={() => void run(async () => setChoices(await port.list(detail.spaceId, isSkill ? 'team_member' : 'skill')))}>Equip</button>}
    {choices && <div role="group" aria-label="Equip picker"><input aria-label="Search skills or teammates" value={search} onChange={e => setSearch(e.target.value)} />
      {!isSkill && <select aria-label="Skill scope filter" value={filter} onChange={e => setFilter(e.target.value)}><option value="">All scopes</option>{Array.from(new Set(choices.map(skillScope))).map(scope => <option key={scope}>{scope}</option>)}</select>}
      {choices.filter(row => `${row.title} ${row.excerpt ?? ''}`.toLowerCase().includes(search.toLowerCase()) && (!filter || skillScope(row) === filter)).map(row => <div key={row.id}><span>{row.title} <small>{skillScope(row)}</small></span> <button disabled={busy || peers.some(p => p.id === row.id) || (row.state.kind === 'skill' && row.state.missing)} onClick={() => void run(async () => { await port!.equip(isSkill ? detail.id : row.id, isSkill ? row.id : detail.id, true); setChoices(null); })}>Equip {row.title}</button></div>)}
      <button onClick={() => setChoices(null)}>Close picker</button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
