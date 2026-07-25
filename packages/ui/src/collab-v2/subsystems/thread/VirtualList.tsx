/**
 * VirtualList — the lightweight windowing the Thread runs on. No new deps.
 *
 * Rows are variable-height (a message with an embedded Z2 card is four times
 * a one-liner), so a fixed row pitch would drift badly. Instead every row
 * starts at `estimateHeight`, real heights are measured after paint, and a
 * prefix-sum offset table is rebuilt only when a measurement actually
 * changes. Scroll position → binary search → a bounded window of rows plus
 * `overscan`, with spacer divs standing in for everything above and below.
 *
 * Consequence: a 10,000-message thread mounts a few dozen DOM rows, and the
 * scrollbar still tells the truth once rows near the viewport are measured.
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';

export interface VirtualListHandle {
  /** Scrolls so `index` sits at the top (or centre) of the viewport. */
  scrollToIndex: (index: number, align?: 'start' | 'center') => void;
  scrollToBottom: () => void;
  isAtBottom: () => boolean;
  element: () => HTMLDivElement | null;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Starting guess per row, refined by measurement. */
  estimateHeight?: number;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  /**
   * Viewport height to assume when the DOM reports none — jsdom and
   * display:none containers both report 0 and would otherwise render nothing.
   */
  fallbackViewport?: number;
  className?: string;
  ariaLabel?: string;
  header?: ReactNode;
  footer?: ReactNode;
  handleRef?: { current: VirtualListHandle | null };
  onAtBottomChange?: (atBottom: boolean) => void;
}

const BOTTOM_SLACK_PX = 32;

/** Largest i with offsets[i] <= y (offsets is ascending, length n+1). */
function indexAtOffset(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function VirtualList<T>({
  items, itemKey, renderItem,
  estimateHeight = 88,
  overscan = 6,
  fallbackViewport = 720,
  className, ariaLabel, header, footer, handleRef, onAtBottomChange,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef<number[]>([]);
  const [measureTick, setMeasureTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const atBottomRef = useRef(true);

  const count = items.length;

  const offsets = useMemo(() => {
    const h = heights.current;
    if (h.length > count) h.length = count;
    while (h.length < count) h.push(estimateHeight);
    const out = new Float64Array(count + 1);
    for (let i = 0; i < count; i += 1) out[i + 1] = out[i] + (h[i] > 0 ? h[i] : estimateHeight);
    return out;
  }, [count, estimateHeight, measureTick]);

  const totalHeight = offsets[count];
  const effectiveViewport = viewport > 0 ? viewport : fallbackViewport;

  const start = Math.max(0, indexAtOffset(offsets, scrollTop) - overscan);
  const end = Math.min(count, indexAtOffset(offsets, scrollTop + effectiveViewport) + 1 + overscan);
  const padTop = offsets[start];
  const padBottom = Math.max(0, totalHeight - offsets[end]);

  // --- viewport size --------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = (): void => setViewport(el.clientHeight);
    read();
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!RO) return;
    const ro = new RO(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- measurement ----------------------------------------------------------
  useLayoutEffect(() => {
    const host = rowsRef.current;
    if (!host) return;
    let changed = false;
    for (const child of Array.from(host.children) as HTMLElement[]) {
      const raw = child.dataset.index;
      if (raw === undefined) continue;
      const i = Number(raw);
      const h = child.offsetHeight;
      // jsdom reports 0 for everything — never poison the table with zeros.
      if (h > 0 && Math.abs((heights.current[i] ?? estimateHeight) - h) > 0.5) {
        heights.current[i] = h;
        changed = true;
      }
    }
    if (changed) setMeasureTick((t) => t + 1);
  });

  // --- scrolling ------------------------------------------------------------
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    if (atBottom !== atBottomRef.current) {
      atBottomRef.current = atBottom;
      onAtBottomChange?.(atBottom);
    }
  }, [onAtBottomChange]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      element: () => scrollRef.current,
      isAtBottom: () => atBottomRef.current,
      scrollToIndex: (index, align = 'start') => {
        const el = scrollRef.current;
        const i = Math.max(0, Math.min(count - 1, index));
        const top = offsets[i] - (align === 'center' ? effectiveViewport / 2 : 0);
        setScrollTop(Math.max(0, top));
        if (el) el.scrollTop = Math.max(0, top);
      },
      scrollToBottom: () => {
        const el = scrollRef.current;
        const top = Math.max(0, totalHeight - effectiveViewport);
        setScrollTop(top);
        if (el) el.scrollTop = el.scrollHeight;
      },
    };
    return () => { handleRef.current = null; };
  }, [handleRef, count, offsets, totalHeight, effectiveViewport]);

  const visibleRows: ReactNode[] = [];
  for (let i = start; i < end; i += 1) {
    visibleRows.push(
      <div key={itemKey(items[i], i)} data-index={i} className="cv2-vrow">
        {renderItem(items[i], i)}
      </div>,
    );
  }

  return (
    <div
      ref={scrollRef}
      className={`cv2-vlist${className ? ` ${className}` : ''}`}
      onScroll={handleScroll}
      aria-label={ariaLabel}
      data-rendered={visibleRows.length}
      data-total={count}
    >
      {header}
      <div ref={rowsRef} className="cv2-vlist__rows" style={{ paddingTop: padTop, paddingBottom: padBottom }}>
        {visibleRows}
      </div>
      {footer}
    </div>
  );
}
