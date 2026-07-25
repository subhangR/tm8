/**
 * EdgeComposer — the minimal inline "+" form on the rail: pick a type, pick
 * the other end, link. Deliberately search-less: entity picking is delegated
 * to a `pickEntity` callback (the ⌘K palette becomes that picker) with a
 * `candidates` chip row as the offline fallback. Opened from a group's "+"
 * it arrives pre-typed and pre-directed.
 */
import { useEffect, useRef, useState } from 'react';
import { EntityChip } from '../../entity';
import { IconBtn } from '../../kit';
import type { EdgeGroup, EntityId, EntitySummary } from '../../types/contract';
import { CUSTOM_TYPE, RAIL_EDGE_TYPES, railEdgeLabel } from './model';

/** Opens a picker (palette in W4) and resolves the chosen entity, or null. */
export type PickEntity = (ctx: {
  sourceId: EntityId;
  type: string;
  direction: EdgeGroup['direction'];
}) => Promise<EntitySummary | null>;

export interface EdgeComposerProps {
  sourceId: EntityId;
  initialType?: string;
  direction: EdgeGroup['direction'];
  /** Fixed type (opened from a group "+") — hides the type select. */
  lockType?: boolean;
  pickEntity?: PickEntity;
  /** Offline candidate chips (recent/known entities) when there is no picker. */
  candidates?: EntitySummary[];
  onSubmit: (input: { type: string; otherId: EntityId; direction: EdgeGroup['direction'] }) => void;
  onCancel: () => void;
}

export function EdgeComposer({
  sourceId, initialType, direction, lockType = false,
  pickEntity, candidates = [], onSubmit, onCancel,
}: EdgeComposerProps) {
  const known = initialType && RAIL_EDGE_TYPES.some((t) => t.type === initialType);
  const [select, setSelect] = useState<string>(known ? (initialType as string) : (initialType ? CUSTOM_TYPE : 'relates_to'));
  const [custom, setCustom] = useState<string>(known || !initialType ? '' : (initialType as string).replace(/^x:/, ''));
  const [picked, setPicked] = useState<EntitySummary | null>(null);
  const [picking, setPicking] = useState(false);
  const firstRef = useRef<HTMLSelectElement | HTMLButtonElement | null>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  const type = select === CUSTOM_TYPE ? `x:${custom.trim().replace(/\s+/g, '_')}` : select;
  const typeReady = select !== CUSTOM_TYPE || custom.trim().length > 0;

  const runPicker = (): void => {
    if (!pickEntity) return;
    setPicking(true);
    void pickEntity({ sourceId, type, direction })
      .then((entity) => { if (entity) setPicked(entity); })
      .catch(() => { /* picker dismissed */ })
      .finally(() => setPicking(false));
  };

  return (
    <form
      className="cv2-rail__composer"
      aria-label={`Link ${railEdgeLabel(type)}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!picked || !typeReady) return;
        onSubmit({ type, otherId: picked.id, direction });
      }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
    >
      <div className="cv2-rail__composerrow">
        {!lockType && (
          <select
            ref={(el) => { if (el && !firstRef.current) firstRef.current = el; }}
            className="cv2-rail__select"
            aria-label="Edge type"
            value={select}
            onChange={(e) => setSelect(e.target.value)}
          >
            {RAIL_EDGE_TYPES.map((t) => (
              <option key={t.type} value={t.type}>{t.label}</option>
            ))}
            <option value={CUSTOM_TYPE}>Custom (x:…)</option>
          </select>
        )}
        {lockType && <span className="cv2-rail__composertype">{railEdgeLabel(type)}</span>}
        {select === CUSTOM_TYPE && (
          <input
            className="cv2-rail__input"
            aria-label="Custom edge type"
            placeholder="inspired_by"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
        <span className="cv2-rail__dir" aria-label={direction === 'outgoing' ? 'outgoing' : 'incoming'}>
          {direction === 'outgoing' ? '→' : '←'}
        </span>
        {picked
          ? <EntityChip entity={picked} interactive={false} draggable={false} />
          : (
            <button
              type="button"
              ref={(el) => { if (el && !firstRef.current) firstRef.current = el; }}
              className="cv2-actionbtn"
              onClick={runPicker}
              disabled={!pickEntity || picking}
              title={pickEntity ? 'Choose the entity to link' : 'Pass pickEntity (⌘K palette) to search — or pick a candidate below'}
            >
              {picking ? 'Choosing…' : 'Choose entity…'}
            </button>
          )}
        <span className="cv2-rail__composeractions">
          <button type="submit" className="cv2-actionbtn cv2-actionbtn--primary" disabled={!picked || !typeReady}>
            Link
          </button>
          <IconBtn aria-label="Cancel link" onClick={onCancel}>✕</IconBtn>
        </span>
      </div>
      {!picked && candidates.length > 0 && (
        <div className="cv2-rail__candidates">
          {candidates.map((c) => (
            <EntityChip key={c.id} entity={c} draggable={false} onOpen={() => setPicked(c)} />
          ))}
        </div>
      )}
    </form>
  );
}
