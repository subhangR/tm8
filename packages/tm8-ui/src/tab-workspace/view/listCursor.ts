/**
 * The Work browser's row cursor (task 01a113aa): `l l` / `l t` put focus on
 * the list, then j/k/↑/↓ move, ←/→ step the lifecycle tabs, Enter opens,
 * `r` launches, Esc leaves.
 *
 * DOM-driven on purpose. The browser hosts `EntityListPanel`, whose tiles come
 * in several anatomies (default, task, session) that already publish their
 * row identity for the flight layer — `data-flight-anchor` /
 * `data-session-node` on the tile directly under a `.lp__branch`. Reading
 * that identity keeps the cursor out of the panel's 5,000 lines and works for
 * every kind, tree or flat, in drawn order.
 */
import { useCallback, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { clickLaunch } from './useWorkspaceKeys';

const ROW_SELECTOR = '.lp__branch > [data-flight-anchor], .lp__branch > [data-session-node]';
const CURSOR_ATTR = 'data-kbd-cursor';

/** The panel's lifecycle tabs (`CategoryTabs`): Running · Interrupted · …, To Do · In Progress · …. */
const STATUS_TAB_SELECTOR = '.lp__tierrow [role="tab"]';

/**
 * Click the lifecycle tab `delta` away from the selected one, wrapping — the
 * same click the pointer makes. False when the list has no tabs.
 */
export function stepStatusTab(root: ParentNode, delta: 1 | -1): boolean {
  const tabs = [...root.querySelectorAll<HTMLElement>(STATUS_TAB_SELECTOR)];
  if (tabs.length === 0) return false;
  const at = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
  const next = tabs[at < 0 ? (delta > 0 ? 0 : tabs.length - 1) : (at + delta + tabs.length) % tabs.length]!;
  next.click();
  return true;
}

function rowId(el: Element): string | null {
  return el.getAttribute('data-flight-anchor') ?? el.getAttribute('data-session-node');
}

export function listRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
}

export interface ListCursorHandlers {
  onFocus(event: FocusEvent<HTMLElement>): void;
  onBlur(event: FocusEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

export function useListCursor(
  listRef: RefObject<HTMLElement | null>,
  open: (entityId: string) => void,
  notify: (text: string) => void,
): ListCursorHandlers {
  const cursor = useRef<string | null>(null);

  const paint = useCallback(
    (rows: HTMLElement[], id: string | null) => {
      for (const row of listRef.current?.querySelectorAll(`[${CURSOR_ATTR}]`) ?? []) row.removeAttribute(CURSOR_ATTR);
      cursor.current = id;
      const el = rows.find((row) => rowId(row) === id);
      if (!el) return;
      el.setAttribute(CURSOR_ATTR, '');
      el.scrollIntoView?.({ block: 'nearest' });
    },
    [listRef],
  );

  const onFocus = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      const rows = listRows(event.currentTarget);
      const kept = rows.find((row) => rowId(row) === cursor.current);
      paint(rows, kept ? cursor.current : rows[0] ? rowId(rows[0]) : null);
    },
    [paint],
  );

  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    for (const row of event.currentTarget.querySelectorAll(`[${CURSOR_ATTR}]`)) row.removeAttribute(CURSOR_ATTR);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // Only the list itself: a row's own button keeps its Enter, the search
      // field keeps its letters.
      if (event.target !== event.currentTarget) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const rows = listRows(event.currentTarget);
      const at = rows.findIndex((row) => rowId(row) === cursor.current);
      const move = (index: number) => {
        const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
        if (row) paint(rows, rowId(row));
      };
      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          move(at + 1);
          break;
        case 'k':
        case 'ArrowUp':
          move(at < 0 ? 0 : at - 1);
          break;
        case 'Home':
          move(0);
          break;
        case 'End':
          move(rows.length - 1);
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (!stepStatusTab(event.currentTarget, event.key === 'ArrowRight' ? 1 : -1)) {
            notify('This list has no status tabs.');
            break;
          }
          // The rows are the new tab's: the next j/↓ starts from the top.
          paint([], null);
          break;
        }
        case 'Enter':
          if (cursor.current && at >= 0) open(cursor.current);
          break;
        case 'r': {
          const row = rows[at];
          if (!row || !clickLaunch(row)) notify('Nothing to launch on this item.');
          break;
        }
        case 'Escape':
          event.currentTarget.blur();
          break;
        default:
          // Everything else (g/n/l/t chords, `c`, `[`, `]`…) reaches the shell.
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [open, notify, paint],
  );

  return { onFocus, onBlur, onKeyDown };
}
