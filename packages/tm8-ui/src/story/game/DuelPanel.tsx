import { useEffect, useRef } from 'react';
import type { WorldEncounter } from './world';

const PHASE_WORD: Record<WorldEncounter['phase'], string> = {
  active: 'In the arena', victory: 'Quest complete', fainted: 'Session failed', resting: 'At rest',
};
export function DuelPanel({ encounter, encounters, onSelect, onOpen, onLeave }: {
  encounter: WorldEncounter; encounters: WorldEncounter[]; onSelect: (id: string) => void;
  onOpen: (id: string) => void; onLeave: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const latest = encounter.activity.at(-1)?.id;
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [encounter.id, latest]);
  const pct = encounter.total ? Math.round(encounter.completed / encounter.total * 100) : 0;
  return <section className={`sgm-duel sgm-duel--${encounter.phase}`} aria-label={`Encounter with ${encounter.name}`} data-testid="story-game-duel">
    <div className="sgm-duel__opponent">
      <div className="sgm-duel__badge" aria-hidden>{encounter.phase === 'victory' ? '✦' : encounter.phase === 'fainted' ? '◇' : '⚡'}</div>
      <div className="sgm-duel__identity"><span className="sgm-eyebrow">TRAINER ENCOUNTER · {encounter.callSign}</span><strong>{encounter.name}</strong><span>{encounter.model ?? 'Model not supplied'} · {encounter.status ?? 'Status unknown'}</span></div>
      <span className="sgm-duel__phase">{PHASE_WORD[encounter.phase]}</span>
      <div className="sgm-duel__vital"><span>SESSION</span><div className={`sgm-duel__energy${encounter.phase === 'active' ? ' sgm-duel__energy--live' : ''}`} aria-label={`Session ${encounter.status ?? 'status unknown'}`}><i /></div></div>
      <div className="sgm-duel__vital"><span>QUESTS</span><progress max={Math.max(1, encounter.total)} value={encounter.completed} aria-label="Attached tasks completed" /><small>{encounter.total ? `${encounter.completed}/${encounter.total} · ${pct}%` : 'No attached tasks'}</small></div>
    </div>
    <div className="sgm-duel__dialogue">
      <div className="sgm-duel__log" ref={log} role="log" aria-label="Recent session messages and activity" aria-live="polite" aria-relevant="additions text">
        {encounter.activity.length ? encounter.activity.map((row) => <p key={row.id}><span>{row.author ?? encounter.name}</span>{row.text}</p>) : <p><span>{encounter.name}</span>{encounter.phase === 'active' ? 'A teammate is working here. Open their session to follow the action.' : 'No recent messages on this session or its attached tasks.'}</p>}
      </div>
      <div className="sgm-duel__actions">
        <button type="button" className="sgm-btn sgm-btn--primary" onClick={() => onOpen(encounter.id)}>Open session <kbd>E</kbd></button>
        <button type="button" className="sgm-btn" onClick={onLeave}>Return to map</button>
        {encounters.length > 1 && <select aria-label="Encounter session" value={encounter.id} onChange={(e) => onSelect(e.target.value)}>{encounters.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.callSign}</option>)}</select>}
      </div>
    </div>
  </section>;
}
