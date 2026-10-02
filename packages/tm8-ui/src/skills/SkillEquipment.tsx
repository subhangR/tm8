import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { KindIcon } from '../domain';
import { Eyebrow } from '../kit/Eyebrow';
import { useMenuAnchor } from '../kit/useMenuAnchor';
import { useDismissable } from '../panels/useDismissable';
import type { SkillPort } from './port';
import { rowDescription, rowScope, type SkillScopeView } from './scope';
import { ScopePills } from './ScopePills';
import './skills.css';

export function skillScope(row: EntitySummary): string {
  return row.state.kind === 'skill' ? `${row.state.provider} · ${row.state.level} · ${row.state.root?.ref ?? 'space'}` : '';
}

/** `code-review`, `code_review` and `code review` are one query. */
const norm = (text: string) => text.toLowerCase().replace(/[-_\s]+/g, ' ');

export function matchesQuery(row: EntitySummary, query: string): boolean {
  const scope = rowScope(row);
  const hay = norm(`${row.title} ${rowDescription(row)} ${scope ? `${scope.level} ${scope.provider} ${scope.where}` : ''}`);
  return norm(query).split(' ').filter(Boolean).every(word => hay.includes(word));
}

const PICKER_HEIGHT = 340;
const PICKER_WIDTH = 320;

/**
 * SKILL EQUIPMENT — the `equips` edge from either end: a teammate's SKILLS, or
 * the teammates a skill is USED BY. Rows open the peer; × unequips at once (it
 * is one click to undo); `+ Equip` opens an anchored picker whose rows toggle.
 */
export function SkillEquipment({ detail, port, onOpenEntity }: { detail: EntityDetail; port?: SkillPort; onOpenEntity?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, [boxRef, menuRef], close);
  const anchor = useMenuAnchor(open, boxRef, menuRef, close, PICKER_HEIGHT, PICKER_WIDTH);
  if (detail.state.kind !== 'skill' && detail.state.kind !== 'team_member') return null;
  const isSkill = detail.state.kind === 'skill';
  const peers = (isSkill ? detail.connections.incoming : detail.connections.outgoing)
    .filter(g => g.type === 'equips')
    .flatMap(g => g.edges.map(e => isSkill ? e.source : e.target));
  const toggle = async (peerId: string, equipped: boolean): Promise<boolean> => {
    setBusy(peerId); setError('');
    try { await port!.equip(isSkill ? detail.id : peerId, isSkill ? peerId : detail.id, equipped); return true; }
    catch (e) { setError(String(e)); return false; }
    finally { setBusy(null); }
  };
  return <section className="sk-equip" aria-label="Skill equipment">
    <div className="sk-equip__head">
      <Eyebrow faint>{isSkill ? 'USED BY' : 'SKILLS'} · {peers.length}</Eyebrow>
      {port && <span className="sk-equip__anchor" ref={boxRef}>
        <button type="button" className="pn-btn sk-equip__add" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          + {isSkill ? 'Equip teammate' : 'Equip skill'}
        </button>
      </span>}
    </div>
    {peers.length ? <ul className="sk-rows">
      {peers.map(peer => <li key={peer.id} className="sk-row">
        <button type="button" className="sk-row__open" onClick={() => onOpenEntity?.(peer.id)} title={peer.title}>
          <span aria-hidden className="sk-row__glyph"><KindIcon kind={peer.kind} /></span>
          <span className="sk-row__text">
            <span className="sk-row__name">{peer.title}</span>
            {rowDescription(peer) && <span className="sk-row__desc">{rowDescription(peer)}</span>}
          </span>
        </button>
        <ScopePills scope={rowScope(peer)} />
        {port && <button type="button" className="sk-row__remove" aria-label={`Unequip ${peer.title}`} title="Unequip" disabled={busy !== null} onClick={() => void toggle(peer.id, false)}>×</button>}
      </li>)}
    </ul> : <p className="pn-section__empty">{isSkill ? 'No teammate is equipped with this skill yet.' : 'No skills equipped yet.'}</p>}
    {error && <p role="alert" className="sk-error">{error}</p>}
    {open && anchor && port ? createPortal(
      <div ref={menuRef} style={anchor.style}>
        <EquipPicker
          spaceId={detail.spaceId}
          kind={isSkill ? 'team_member' : 'skill'}
          port={port}
          equippedIds={peers.map(p => p.id)}
          busy={busy}
          error={error}
          onToggle={toggle}
        />
      </div>,
      anchor.host,
    ) : null}
  </section>;
}

interface Group { key: string; scope: SkillScopeView | null; rows: EntitySummary[] }

function EquipPicker({ spaceId, kind, port, equippedIds, busy, error, onToggle }: {
  spaceId: string; kind: 'skill' | 'team_member'; port: SkillPort; equippedIds: readonly string[]; busy: string | null; error: string; onToggle: (id: string, on: boolean) => Promise<boolean>;
}) {
  const [choices, setChoices] = useState<EntitySummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  /* What a click asked for, held until the edge event lands in `equippedIds`
     — so the ✓ answers the click instead of waiting on the round trip. */
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const equippedKey = equippedIds.join(',');
  useEffect(() => { setAsked({}); }, [equippedKey]);
  useEffect(() => {
    let live = true;
    port.list(spaceId, kind).then(rows => { if (live) setChoices(rows); }, e => { if (live) setLoadError(String(e)); });
    return () => { live = false; };
  }, [port, spaceId, kind]);
  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Group>();
    for (const row of (choices ?? []).filter(r => matchesQuery(r, query))) {
      const key = skillScope(row);
      const group = byKey.get(key) ?? { key, scope: rowScope(row), rows: [] };
      group.rows.push(row);
      byKey.set(key, group);
    }
    return [...byKey.values()];
  }, [choices, query]);
  const noun = kind === 'skill' ? 'skills' : 'teammates';
  return <div className="sk-picker" role="dialog" aria-label="Equip picker">
    <input
      className="sk-input sk-picker__search"
      aria-label={`Search ${noun}`}
      placeholder={`Search ${noun}…`}
      value={query}
      autoFocus
      onChange={e => setQuery(e.target.value)}
    />
    <div className="sk-picker__list">
      {loadError ? <p role="alert" className="sk-error">{loadError}</p>
        : !choices ? <p className="sk-picker__note">Loading {noun}…</p>
        : !groups.length ? <p className="sk-picker__note">{query ? `No ${noun} match “${query}”.` : `No ${noun} in this space yet.`}</p>
        : groups.map(group => <div key={group.key} role="group" aria-label={group.key || noun} className="sk-picker__group">
          {group.scope && <div className="sk-picker__grouphead" title={group.scope.where}>
            <span>{[group.scope.level, group.scope.provider].filter(Boolean).join(' · ')}</span>
            {group.scope.where && <span className="sk-picker__where">{group.scope.where}</span>}
          </div>}
          {group.rows.map(row => {
            const on = asked[row.id] ?? equippedIds.includes(row.id);
            const missing = row.state.kind === 'skill' && row.state.missing;
            return <button
              key={row.id}
              type="button"
              className={on ? 'sk-opt sk-opt--on' : 'sk-opt'}
              aria-pressed={on}
              aria-label={row.title}
              disabled={busy !== null || (missing && !on)}
              title={missing ? 'Skill file is missing on disk' : rowDescription(row) || row.title}
              onClick={() => {
                setAsked(a => ({ ...a, [row.id]: !on }));
                void onToggle(row.id, !on).then(ok => { if (!ok) setAsked(a => { const { [row.id]: _, ...rest } = a; return rest; }); });
              }}
            >
              <span aria-hidden className="sk-opt__check">{on ? '✓' : ''}</span>
              <span className="sk-opt__text">
                <span className="sk-opt__name">{row.title}{missing && <span className="sk-opt__flag">missing</span>}</span>
                {rowDescription(row) && <span className="sk-opt__desc">{rowDescription(row)}</span>}
              </span>
            </button>;
          })}
        </div>)}
    </div>
    {error && <p role="alert" className="sk-error sk-picker__error">{error}</p>}
  </div>;
}
