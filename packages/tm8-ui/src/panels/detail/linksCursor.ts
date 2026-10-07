/**
 * The Links list's row cursor (task 01a11567): `t l` opens a tab's Links and
 * puts focus on the list, then j/k/↑/↓ move, Enter (or o) opens the peer under
 * the cursor, Home/End jump, and Esc leaves the list.
 *
 * The same grammar as the Work browser's row cursor (`tab-workspace/view/
 * listCursor.ts`) — one set of keys to learn — but this list is drawn by the
 * Connections tab itself, so the rows publish their identity directly
 * (`data-peer-id` on each `.pn-peers__row`) and no DOM archaeology is needed.
 * The cursor is a DOM attribute (`data-kbd-cursor`, the browser's own mark) so
 * the stylesheet draws it with the one rule it already has for a cursor.
 *
 * Every key the cursor does NOT handle falls through to the shell: `]`, `[`,
 * `w`, `r`, the `g`/`n`/`l`/`t` chords all keep working while the list has
 * focus, which is what makes this an extension of the keyboard and not a mode.
 */
import { useCallback, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';

const ROW_SELECTOR = '[data-peer-id]';
const CURSOR_ATTR = 'data-kbd-cursor';

function rowId(el: Element): string | null {
  return el.getAttribute('data-peer-id');
}

export function linkRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
}

export interface LinksCursorHandlers {
  onFocus(event: FocusEvent<HTMLElement>): void;
  onBlur(event: FocusEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

export function useLinksCursor(
  listRef: RefObject<HTMLElement | null>,
  open: (entityId: string) => void,
): LinksCursorHandlers {
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
      const rows = linkRows(event.currentTarget);
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
      // Only the list itself: a row's chip keeps its own Enter and Space.
      if (event.target !== event.currentTarget) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const rows = linkRows(event.currentTarget);
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
        case 'Enter':
        case 'o':
          if (cursor.current && at >= 0) open(cursor.current);
          break;
        case 'Escape':
          event.currentTarget.blur();
          break;
        default:
          // Everything else (tabs, chords, `r`, `w`…) reaches the shell.
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [open, paint],
  );

  return { onFocus, onBlur, onKeyDown };
}
