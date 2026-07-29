/**
 * useListNav — roving-focus wrapper over the shell's `createListKeyNav`.
 * One active index per collection; arrows move it, Enter activates, focus
 * follows the index so screen readers track the same cell.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createListKeyNav, type KeyEventLike } from '../shell/keyboard';

export interface ListNav {
  index: number;
  setIndex: (i: number) => void;
  /** Attach to the scroll container (onKeyDown). */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Spread onto each cell: tabIndex + ref registration. */
  cellProps: (i: number) => {
    tabIndex: number;
    ref: (el: HTMLElement | null) => void;
    'data-nav-index': number;
  };
}

export function useListNav(
  count: number,
  onActivate: (index: number) => void,
  opts: { orientation?: 'vertical' | 'horizontal' | 'grid'; columns?: number } = {},
): ListNav {
  const [index, setIndex] = useState(0);
  const cells = useRef<Array<HTMLElement | null>>([]);
  cells.current.length = count;

  useEffect(() => {
    if (count > 0 && index >= count) setIndex(count - 1);
  }, [count, index]);

  const onKeyDown = useCallback((e: React.KeyboardEvent): void => {
    const nav = createListKeyNav({
      count,
      index,
      orientation: opts.orientation ?? 'vertical',
      columns: opts.columns,
      onIndexChange: (next) => {
        setIndex(next);
        cells.current[next]?.focus();
      },
      onActivate,
    });
    nav(e as unknown as KeyEventLike);
  }, [count, index, onActivate, opts.orientation, opts.columns]);

  const cellProps = useCallback((i: number) => ({
    tabIndex: i === index ? 0 : -1,
    ref: (el: HTMLElement | null) => { cells.current[i] = el; },
    'data-nav-index': i,
  }), [index]);

  return { index, setIndex, onKeyDown, cellProps };
}
