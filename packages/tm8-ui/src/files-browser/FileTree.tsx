import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { DirView } from './roots';

/**
 * THE LISTING PANE, NAVIGABLE FROM THE KEYBOARD.
 *
 * WHY A ROVING TABINDEX AND NOT A LIST OF BUTTONS. A directory of four hundred
 * files rendered as four hundred buttons puts four hundred stops between the
 * tree and the next control on the screen. The ARIA pattern for this is one
 * tabstop for the whole tree plus arrow keys inside it, so the rest of the
 * screen stays reachable. That is a behaviour, so it is asserted: the suite
 * checks `document.activeElement` after each key, not merely that a handler
 * fired.
 *
 * FOCUS IS MOVED, NOT SIMULATED. `aria-activedescendant` would leave real focus
 * on the container and is easy to get subtly wrong with screen readers; here
 * the focused row IS the focused element, which is the version a keyboard user
 * can verify.
 *
 * DIRECTION HAS MEANING: Right descends (into a directory), Left ascends (to
 * the parent), matching the tree pattern — so Left works even when the `../`
 * row is scrolled out of sight.
 */

interface Row {
  key: string;
  kind: 'up' | 'dir' | 'file';
  label: string;
  /** `null` on the `../` row when the parent is the root itself. */
  path: string | null;
  sizeBytes?: number | null;
}

export interface FileTreeProps {
  view: DirView;
  selectedPath: string | null;
  onEnterDir: (path: string | undefined) => void;
  onOpenFile: (path: string) => void;
}

function sizeLabel(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileTree({ view, selectedPath, onEnterDir, onOpenFile }: FileTreeProps) {
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (view.parentPath !== null) {
      out.push({ key: '..', kind: 'up', label: '../', path: view.parentPath });
    }
    for (const dir of view.directories) {
      out.push({ key: `d:${dir.path}`, kind: 'dir', label: dir.name, path: dir.path });
    }
    for (const file of view.files) {
      out.push({
        key: `f:${file.path}`, kind: 'file', label: file.name,
        path: file.path, sizeBytes: file.sizeBytes,
      });
    }
    return out;
  }, [view]);

  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  // Entering a directory replaces every row; keeping the old index would land
  // the cursor on an unrelated file.
  useEffect(() => { setActive(0); }, [view.path]);

  const focusRow = useCallback((index: number) => {
    setActive(index);
    refs.current[index]?.focus();
  }, []);

  const activate = useCallback(
    (row: Row) => {
      if (row.kind === 'file') { if (row.path) onOpenFile(row.path); return; }
      onEnterDir(row.path ?? undefined);
    },
    [onEnterDir, onOpenFile],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number) => {
      const row = rows[index];
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          focusRow(Math.min(index + 1, rows.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusRow(Math.max(index - 1, 0));
          break;
        case 'Home':
          event.preventDefault();
          focusRow(0);
          break;
        case 'End':
          event.preventDefault();
          focusRow(rows.length - 1);
          break;
        case 'ArrowRight':
          if (row.kind === 'dir') { event.preventDefault(); onEnterDir(row.path ?? undefined); }
          break;
        case 'ArrowLeft':
          if (view.parentPath !== null) { event.preventDefault(); onEnterDir(view.parentPath); }
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          activate(row);
          break;
        default:
          break;
      }
    },
    [activate, focusRow, onEnterDir, rows, view.parentPath],
  );

  return (
    <div className="fb-tree" role="tree" aria-label="Files" data-testid="files-tree">
      {rows.map((row, index) => (
        <div
          key={row.key}
          ref={(node) => { refs.current[index] = node; }}
          role="treeitem"
          aria-selected={row.kind === 'file' && row.path === selectedPath}
          aria-label={row.kind === 'dir' ? `${row.label}, folder` : row.label}
          // ONE tabstop for the whole tree — see the header.
          tabIndex={index === active ? 0 : -1}
          className={`fb-row fb-row-${row.kind}${
            row.kind === 'file' && row.path === selectedPath ? ' fb-row-on' : ''
          }`}
          data-testid={
            row.kind === 'up'
              ? 'files-up'
              : row.kind === 'dir'
                ? `files-dir-${row.label}`
                : `files-entry-${row.label}`
          }
          onClick={() => { setActive(index); activate(row); }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          <span className="fb-name">{row.kind === 'dir' ? `${row.label}/` : row.label}</span>
          {row.kind === 'file' ? (
            <span className="fb-size">{sizeLabel(row.sizeBytes)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
