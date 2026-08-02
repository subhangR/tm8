/**
 * listKeyNav — kit-level (L0) arrow-key primitive for roving-focus lists,
 * boards and grids. Lives in kit/ so subsystems (L2) and collections (L4)
 * consume it without importing upward from shell (DEF-15); shell/keyboard
 * re-exports it for existing consumers.
 */

/** The subset of KeyboardEvent the handlers read — tests pass literals. */
export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
  preventDefault?: () => void;
}

export interface ListKeyNavOptions {
  count: number;
  index: number;
  onIndexChange: (index: number) => void;
  onActivate?: (index: number) => void;
  orientation?: 'vertical' | 'horizontal' | 'grid';
  /** Columns — required for `grid`, where Up/Down move a whole row. */
  columns?: number;
  loop?: boolean;
}

/**
 * Arrow/Home/End/Enter handling for a roving-focus list, board or grid.
 * Returns true when the event was consumed.
 */
export function createListKeyNav(opts: ListKeyNavOptions): (e: KeyEventLike) => boolean {
  const { count, index, onIndexChange, onActivate, loop = false } = opts;
  const orientation = opts.orientation ?? 'vertical';
  const columns = Math.max(1, opts.columns ?? 1);

  const clamp = (next: number): number => {
    if (count === 0) return 0;
    if (loop) return ((next % count) + count) % count;
    return Math.min(count - 1, Math.max(0, next));
  };

  return (e) => {
    if (count === 0) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const move = (next: number) => {
      const target = clamp(next);
      if (target !== index) onIndexChange(target);
      e.preventDefault?.();
      return true;
    };
    switch (e.key) {
      case 'ArrowDown':
        if (orientation === 'horizontal') return false;
        return move(index + (orientation === 'grid' ? columns : 1));
      case 'ArrowUp':
        if (orientation === 'horizontal') return false;
        return move(index - (orientation === 'grid' ? columns : 1));
      case 'ArrowRight':
        if (orientation === 'vertical') return false;
        return move(index + 1);
      case 'ArrowLeft':
        if (orientation === 'vertical') return false;
        return move(index - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(count - 1);
      case 'Enter':
        if (!onActivate) return false;
        onActivate(index);
        e.preventDefault?.();
        return true;
      default:
        return false;
    }
  };
}
