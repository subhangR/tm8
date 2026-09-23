import { useEffect, useState, type ReactNode } from 'react';
import type { EffectiveSkills, SkillPreviewResult } from '@tm8/contract';
import type { SkillPort } from './port';
export function SkillGroups({ skills, onOpenEntity }: { skills: EffectiveSkills; onOpenEntity?: (id: string) => void }) {
  return <div>{(['native', 'indexed', 'skipped'] as const).map(group => <section key={group} aria-label={`${group} skills`}><h4>{group.toUpperCase()}</h4>{skills[group].length ? skills[group].map(row => <p key={row.entityId}><button onClick={() => onOpenEntity?.(row.entityId)}>{row.name}</button> {'reason' in row ? row.reason : `${row.provider} · ${row.level}`} {row.hash && <code>{row.hash}</code>}</p>) : <p>None</p>}</section>)}<small>Scanned {skills.scannedAt ?? 'not recorded'}</small></div>;
}
export function SkillPreview({ load, teamMemberId, projectId, agentTool, children }: { load?: (input: Parameters<SkillPort['preview']>[1]) => Promise<SkillPreviewResult>; teamMemberId: string; projectId?: string; agentTool?: string; children?: ReactNode }) {
  const [skills, setSkills] = useState<SkillPreviewResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; setSkills(null); setError(''); if (load && teamMemberId) void load({ teamMemberId, projectId, agentTool }).then(value => { if (active) setSkills(value); }, e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [load, teamMemberId, projectId, agentTool]);
  return <section className="ls__section"><div className="ls__eyebrow">SKILLS</div>{error ? <p role="alert">{error}</p> : skills ? <><SkillGroups skills={skills} />{skills.rows.filter(r => r.missing).map(r => <p key={r.entityId}>Missing: {r.name} · {r.sourcePath}</p>)}</> : <p>{load ? 'Loading skill preview…' : 'Skill preview unavailable'}</p>}{children}</section>;
}
