/**
 * Collection controls — layout switcher (six layouts on ANY collection),
 * the groupBy pivot (status / assignee / EVERY axis, default and manual
 * rendered identically), and save-view (name + share-to-space → facade).
 */
import { useState } from 'react';
import type {
  CollectionQuery, SavedView, TaskAxis,
} from '../types/contract';
import type { GroupByKey } from './grouping';

export const COLLECTION_LAYOUTS = ['list', 'board', 'tree', 'feed', 'gallery', 'graph'] as const;
export type CollectionLayout = typeof COLLECTION_LAYOUTS[number];

const LAYOUT_LABELS: Record<CollectionLayout, string> = {
  list: 'List', board: 'Board', tree: 'Tree', feed: 'Feed', gallery: 'Gallery', graph: 'Graph',
};

export function LayoutSwitcher({ value, onChange }: {
  value: CollectionLayout;
  onChange: (l: CollectionLayout) => void;
}) {
  return (
    <div className="cv2-collection__switcher" role="tablist" aria-label="Layout">
      {COLLECTION_LAYOUTS.map((l) => (
        <button
          key={l}
          type="button"
          role="tab"
          aria-selected={value === l}
          className={`cv2-collection__tab${value === l ? ' cv2-collection__tab--active' : ''}`}
          onClick={() => onChange(l)}
        >
          {LAYOUT_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

/**
 * The pivot: one chip per grouping axis. `workStatus` and `assignee` are
 * built-in axes; every TaskAxis (kind `default` OR `manual` — no visual or
 * behavioral difference) appears the same way.
 */
export function GroupByPivot({ value, axes, onChange }: {
  value: GroupByKey | undefined;
  axes: TaskAxis[];
  onChange: (g: GroupByKey | undefined) => void;
}) {
  const options: Array<{ key: GroupByKey | undefined; label: string }> = [
    { key: undefined, label: 'None' },
    { key: 'workStatus', label: 'Status' },
    { key: 'assignee', label: 'Assignee' },
    ...[...axes]
      .sort((a, b) => a.position - b.position)
      .map((a) => ({ key: `axis:${a.name}` as GroupByKey, label: a.name })),
  ];
  return (
    <div className="cv2-collection__pivot" role="radiogroup" aria-label="Group by">
      <span className="cv2-collection__pivotlabel">group</span>
      {options.map((o) => (
        <button
          key={o.key ?? 'none'}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          className={`cv2-collection__chip${value === o.key ? ' cv2-collection__chip--active' : ''}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SaveViewControl({ query, graphLayout, onSave }: {
  query: CollectionQuery;
  /** Current graph node positions when the graph layout is active. */
  graphLayout?: Record<string, { x: number; y: number }> | null;
  onSave: (input: { name: string; shareMode: 'private' | 'space'; query: CollectionQuery; graphLayout?: Record<string, { x: number; y: number }> }) => Promise<SavedView>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAs, setSavedAs] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const view = await onSave({
        name: name.trim(),
        shareMode: share ? 'space' : 'private',
        query,
        graphLayout: graphLayout ?? undefined,
      });
      setSavedAs(view.name);
      setOpen(false);
      setName('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cv2-collection__saveview">
      <button type="button" className="cv2-collection__chip" onClick={() => setOpen((o) => !o)}>
        Save view
      </button>
      {savedAs && !open && <span className="cv2-collection__savedhint">saved “{savedAs}”</span>}
      {open && (
        <form
          className="cv2-collection__saveform"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          <input
            className="cv2-collection__saveinput"
            placeholder="View name"
            value={name}
            aria-label="View name"
            onChange={(e) => setName(e.target.value)}
          />
          <label className="cv2-collection__savecheck">
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
            share to space
          </label>
          <button type="submit" className="cv2-collection__chip cv2-collection__chip--active" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </div>
  );
}
