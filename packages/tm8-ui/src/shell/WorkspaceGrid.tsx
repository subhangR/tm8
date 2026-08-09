/**
 * WorkspaceGrid (LLD §5.1) — the three-column workspace: side panel · center
 * stage · side panel, with `G = 8px` gaps that double as the resize-handle
 * track (WLT §6; supersedes the old 6px resizer track).
 *
 * L4 is enforced structurally: every grid track carries a real floor. No
 * zero-floored track and no unfloored `overflow:hidden` flex appears in this
 * component or `shell.css` — §15.2 greps for exactly that pattern, so this file
 * avoids even writing it in prose.
 *
 * The solved widths arrive as CSS custom properties rather than as a media
 * query, because WLT §6 makes the breakpoint constants **derived at reference
 * capture by measurement**. A hard-coded `@media (max-width: 1280px)` would be
 * asserting a constant the spec says must be measured.
 */
import { useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  GRID_GAP,
  LEFT_PANEL_MIN,
  PANEL_COL_MIN,
  RIGHT_PANEL_MIN,
  type WorkspaceLayout,
} from './geometry';

export interface WorkspaceGridProps {
  layout: WorkspaceLayout;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  leftLabel?: string;
  rightLabel?: string;
  onMovePanel?(from: WorkspacePanelSide, to: WorkspacePanelSide): void;
  onResizePanel?(side: WorkspacePanelSide, width: number): void;
  onResetPanelWidth?(side: WorkspacePanelSide): void;
  /** Measured by the caller's ResizeObserver; drives the demotion loop. */
  centerRef?: React.RefCallback<HTMLDivElement>;
  /**
   * The side whose list is showing a BOARD, if either is. A board column has a
   * 236px floor and the side tracks default to 240/319, so a board in a side
   * track is one column wide; that panel spans the whole grid instead.
   *
   * THE CENTRE IS NOT UNMOUNTED AND NOT HIDDEN — it is COVERED. Unmounting it
   * would destroy the terminal pool's DOM, and `visibility: hidden` would be
   * overridden from inside anyway (CenterPane sets `visibility` per layer to
   * drive its own LRU). A spanning, opaque panel above it in paint order
   * leaves every terminal mounted, sized and running underneath, so switching
   * back to the list costs no reconnect.
   */
  boardSide?: WorkspacePanelSide | null;
}

export type WorkspacePanelSide = 'left' | 'right';

const PANEL_DRAG_TYPE = 'application/x-tm8-workspace-panel';

export function WorkspaceGrid({
  layout,
  left,
  center,
  right,
  leftLabel = 'Left',
  rightLabel = 'Right',
  onMovePanel,
  onResizePanel,
  onResetPanelWidth,
  centerRef,
  boardSide = null,
}: WorkspaceGridProps) {
  const stacked = layout.stackMode !== 'columns';
  const [dragging, setDragging] = useState<WorkspacePanelSide | null>(null);
  const [dragOver, setDragOver] = useState<WorkspacePanelSide | null>(null);

  const style = {
    // Floors are handed to CSS as values, never re-typed into the stylesheet,
    // so `geometry.ts` stays the single home of the floor set (L4).
    '--ws-gap': `${GRID_GAP}px`,
    '--ws-left': `${layout.left}px`,
    '--ws-right': `${layout.right}px`,
    '--ws-left-min': `${LEFT_PANEL_MIN}px`,
    '--ws-right-min': `${RIGHT_PANEL_MIN}px`,
    '--ws-cmin': `${layout.centerMin}px`,
    '--ws-panel-col': `${PANEL_COL_MIN}px`,
  } as React.CSSProperties;

  const labelFor = (side: WorkspacePanelSide): string =>
    side === 'left' ? leftLabel : rightLabel;

  const beginPanelDrag = (side: WorkspacePanelSide, event: DragEvent<HTMLButtonElement>) => {
    if (!onMovePanel) return;
    setDragging(side);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PANEL_DRAG_TYPE, side);
    event.dataTransfer.setData('text/plain', side);
  };

  const dropPanel = (to: WorkspacePanelSide, event: DragEvent<HTMLElement>) => {
    if (!onMovePanel) return;
    event.preventDefault();
    const transferred = event.dataTransfer.getData(PANEL_DRAG_TYPE);
    const from = transferred === 'left' || transferred === 'right' ? transferred : dragging;
    setDragging(null);
    setDragOver(null);
    if (from && from !== to) onMovePanel(from, to);
  };

  const movePanelByKeyboard = (
    from: WorkspacePanelSide,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!onMovePanel) return;
    const to = from === 'left' ? 'right' : 'left';
    const movesTowardTarget =
      event.key === 'Enter' ||
      event.key === ' ' ||
      (from === 'left' && event.key === 'ArrowRight') ||
      (from === 'right' && event.key === 'ArrowLeft');
    if (!movesTowardTarget) return;
    event.preventDefault();
    onMovePanel(from, to);
  };

  const sidePanel = (side: WorkspacePanelSide, content: ReactNode) => {
    const target = side === 'left' ? 'right' : 'left';
    return (
      <section
        id={`workspace-panel-${side}`}
        className={[
          'shell-ws__side',
          `shell-ws__side--${side}`,
          dragOver === side && dragging !== side ? 'shell-ws__side--drop' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={`${side === 'left' ? 'Left' : 'Right'} panel`}
        data-dock={side}
        data-stacked={stacked || undefined}
        onDragEnter={(event) => {
          if (!dragging || dragging === side) return;
          event.preventDefault();
          setDragOver(side);
        }}
        onDragOver={(event) => {
          if (!dragging || dragging === side) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(null);
        }}
        onDrop={(event) => dropPanel(side, event)}
      >
        {onMovePanel ? (
          <button
            type="button"
            className="shell-ws__dock-grip"
            draggable
            aria-label={`Drag ${labelFor(side)} panel; press Enter to move to ${target}`}
            title={`Drag to the ${target} side · Enter also moves it`}
            data-dragging={dragging === side || undefined}
            onDragStart={(event) => beginPanelDrag(side, event)}
            onDragEnd={() => {
              setDragging(null);
              setDragOver(null);
            }}
            onKeyDown={(event) => movePanelByKeyboard(side, event)}
          >
            <span aria-hidden>⠿</span>
          </button>
        ) : null}
        <div className="shell-ws__side-content">{content}</div>
      </section>
    );
  };

  const leftResizeMax = layout.left + Math.max(0, layout.center - layout.centerMin);
  const rightResizeMax = layout.right + Math.max(0, layout.center - layout.centerMin);

  return (
    <div
      className={`shell-ws shell-ws--${layout.stackMode}`}
      style={style}
      data-testid="workspace-grid"
      data-stack-mode={layout.stackMode}
      data-below-floors={layout.belowFloors || undefined}
      data-board-side={boardSide ?? undefined}
    >
      {sidePanel('left', left)}

      <WorkspaceResizeHandle
        side="left"
        label={leftLabel}
        width={layout.left}
        minWidth={LEFT_PANEL_MIN}
        maxWidth={leftResizeMax}
        disabled={layout.left === 0}
        onResize={onResizePanel}
        onReset={onResetPanelWidth}
      />

      {/* The ink stage. It is dark in BOTH themes by design (LLD §12 — the
          terminal canvas keeps its established contrast), so it opens a
          `data-theme="dark"` scope: everything inside resolves against the dark
          token set instead of reaching for a raw hex the palette has no name
          for. Colors always go through tokens (D5). */}
      <main
        className="shell-ws__center"
        data-theme="dark"
        ref={centerRef}
        aria-label="Workspace center"
      >
        {center}
      </main>

      <WorkspaceResizeHandle
        side="right"
        label={rightLabel}
        width={layout.right}
        minWidth={RIGHT_PANEL_MIN}
        maxWidth={rightResizeMax}
        disabled={layout.right === 0}
        onResize={onResizePanel}
        onReset={onResetPanelWidth}
      />

      {sidePanel('right', right)}
    </div>
  );
}

interface WorkspaceResizeHandleProps {
  side: WorkspacePanelSide;
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  disabled: boolean;
  onResize?: WorkspaceGridProps['onResizePanel'];
  onReset?: WorkspaceGridProps['onResetPanelWidth'];
}

const RESIZE_STEP = 16;

function WorkspaceResizeHandle(props: WorkspaceResizeHandleProps) {
  const { side, label, width, minWidth, maxWidth, disabled, onResize, onReset } = props;
  const drag = useRef<{ pointerId: number; x: number; width: number; maxWidth: number } | null>(
    null,
  );
  const [resizing, setResizing] = useState(false);
  const interactive = !disabled && onResize != null;
  const clamp = (next: number, maximum = maxWidth) =>
    Math.min(Math.max(minWidth, next), Math.max(minWidth, maximum));

  const resizeFromSeparatorMovement = (movement: number, maximum = maxWidth) => {
    if (!onResize) return;
    const panelMovement = side === 'left' ? movement : -movement;
    onResize(side, clamp(width + panelMovement, maximum));
  };

  const stopResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div
      className="shell-ws__gap"
      role="separator"
      aria-label={`Resize ${label} panel`}
      aria-orientation="vertical"
      aria-controls={`workspace-panel-${side}`}
      aria-valuemin={minWidth}
      aria-valuemax={Math.round(maxWidth)}
      aria-valuenow={Math.round(width)}
      aria-disabled={!interactive || undefined}
      tabIndex={interactive ? 0 : -1}
      data-resizing={resizing || undefined}
      data-side={side}
      onDoubleClick={() => {
        if (interactive) onReset?.(side);
      }}
      onPointerDown={(event) => {
        if (!interactive || event.button !== 0) return;
        event.preventDefault();
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width,
          maxWidth,
        };
        setResizing(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId || !onResize) return;
        const movement = event.clientX - start.x;
        const panelMovement = side === 'left' ? movement : -movement;
        onResize(side, clamp(start.width + panelMovement, start.maxWidth));
      }}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={(event) => {
        if (!interactive) return;
        if (event.key === 'Home') {
          event.preventDefault();
          onResize(side, minWidth);
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          onResize(side, maxWidth);
          return;
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        resizeFromSeparatorMovement(event.key === 'ArrowLeft' ? -RESIZE_STEP : RESIZE_STEP);
      }}
    >
      <span className="shell-ws__gap-line" aria-hidden />
    </div>
  );
}
