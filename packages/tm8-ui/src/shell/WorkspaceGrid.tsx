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
import type { ReactNode } from 'react';
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
  /** Measured by the caller's ResizeObserver; drives the demotion loop. */
  centerRef?: React.RefCallback<HTMLDivElement>;
}

export function WorkspaceGrid({ layout, left, center, right, centerRef }: WorkspaceGridProps) {
  const stacked = layout.stackMode !== 'columns';

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

  return (
    <div
      className={`shell-ws shell-ws--${layout.stackMode}`}
      style={style}
      data-testid="workspace-grid"
      data-stack-mode={layout.stackMode}
      data-below-floors={layout.belowFloors || undefined}
    >
      <section
        className="shell-ws__side shell-ws__side--left"
        aria-label="Left panel"
        data-stacked={stacked || undefined}
      >
        {left}
      </section>

      <div className="shell-ws__gap" role="separator" aria-orientation="vertical" />

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

      <div className="shell-ws__gap" role="separator" aria-orientation="vertical" />

      <section
        className="shell-ws__side shell-ws__side--right"
        aria-label="Right panel"
        data-stacked={stacked || undefined}
      >
        {right}
      </section>
    </div>
  );
}
