import { useCallback, useState, type ReactNode } from 'react';
import type { ChangeTreeDir } from './change-paths';

/**
 * THE TWO PIECES BOTH CHANGES BODIES DRAW THE SAME WAY — the Tree | List
 * switch and a folder row — so a lane's list and a transcript's list do not
 * grow two ideas of what a folder looks like.
 *
 * NOT AN ARIA TREE. `role="tree"` promises arrow-key navigation, typeahead and
 * a roving focus this list does not implement; a screen reader would announce
 * keys that do nothing. Folders are disclosure buttons (`aria-expanded`) in an
 * ordinary list, which is exactly what they are. The same reasoning keeps the
 * filter chips off `role="tab"`.
 */

export type ChangesView = 'tree' | 'list';

export function ChangesViewToggle({ view, onChange }: { view: ChangesView; onChange: (v: ChangesView) => void }) {
  return (
    <span className="pn-chg__view" role="group" aria-label="Show changed files as">
      {(['tree', 'list'] as const).map((v) => (
        <button
          key={v}
          type="button"
          className="pn-chg__view-btn"
          aria-pressed={view === v}
          data-testid={`session-changes-view-${v}`}
          onClick={() => onChange(v)}
        >
          {v === 'tree' ? 'Tree' : 'List'}
        </button>
      ))}
    </span>
  );
}

/** Folders the viewer shut, for this mount only. Empty means all open. */
export function useCollapsedFolders(): { collapsed: ReadonlySet<string>; toggle: (path: string) => void } {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

export function ChangeDirRow<T>({
  dir,
  depth,
  open,
  onToggle,
  extra,
}: {
  dir: ChangeTreeDir<T>;
  depth: number;
  open: boolean;
  onToggle: () => void;
  /** Anything the folder summarises about its files, after the count. */
  extra?: ReactNode;
}) {
  return (
    <li
      className="pn-chg__dir"
      data-testid="session-changes-dir"
      data-path={dir.path}
      style={{ '--pn-chg-depth': depth } as never}
    >
      <button
        type="button"
        className="pn-chg__dir-toggle"
        aria-expanded={open}
        title={dir.path}
        onClick={onToggle}
      >
        <span aria-hidden className="pn-chg__twisty">{open ? '▾' : '▸'}</span>
        <span className="pn-chg__dir-name">{dir.name}/</span>
        <span className="pn-chg__dir-count">{dir.fileCount}</span>
      </button>
      {extra}
    </li>
  );
}
