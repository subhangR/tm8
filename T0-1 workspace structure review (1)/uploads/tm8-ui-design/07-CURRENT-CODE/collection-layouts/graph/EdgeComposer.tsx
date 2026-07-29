/**
 * EdgeComposer — dragging node→node on the canvas lands here: pick the edge
 * type (core taxonomy + free-form x:*), then `createEdge`.
 */
import { useState } from 'react';
import { EntityChip } from '../../entity';
import type { EntitySummary } from '../../types/contract';

export interface EdgeDraft { source: EntitySummary; target: EntitySummary }

const CORE_TYPES: Array<{ type: string; label: string; props?: Record<string, unknown> }> = [
  { type: 'depends_on', label: 'depends on · hard (blocks)', props: { hard: true } },
  { type: 'depends_on', label: 'depends on · soft', props: { hard: false } },
  { type: 'relates_to', label: 'relates to' },
  { type: 'attached_to', label: 'attached to' },
  { type: 'assigned_to', label: 'assigned to' },
  { type: 'tracks', label: 'tracks' },
  { type: 'equips', label: 'equips' },
];

export function EdgeComposer({ draft, onConfirm, onCancel }: {
  draft: EdgeDraft;
  onConfirm: (type: string, props?: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [custom, setCustom] = useState('');
  return (
    <div className="cv2-edgecomposer" role="dialog" aria-label="Create edge">
      <div className="cv2-edgecomposer__head">
        <EntityChip entity={draft.source} variant="ref" interactive={false} draggable={false} />
        <span className="cv2-edgecomposer__arrow">→</span>
        <EntityChip entity={draft.target} variant="ref" interactive={false} draggable={false} />
      </div>
      <div className="cv2-edgecomposer__types">
        {CORE_TYPES.map((t) => (
          <button
            key={t.label}
            type="button"
            className="cv2-collection__chip"
            onClick={() => onConfirm(t.type, t.props)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <form
        className="cv2-edgecomposer__custom"
        onSubmit={(e) => {
          e.preventDefault();
          const name = custom.trim().toLowerCase().replace(/\s+/g, '_');
          if (name) onConfirm(`x:${name}`);
        }}
      >
        <input
          className="cv2-collection__saveinput"
          placeholder="custom type (x:…)"
          aria-label="Custom edge type"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <button type="submit" className="cv2-collection__chip" disabled={!custom.trim()}>add</button>
      </form>
      <button type="button" className="cv2-edgecomposer__cancel" onClick={onCancel}>cancel</button>
    </div>
  );
}
