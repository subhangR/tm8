/**
 * THE APP FRAME (chat + Observe shell alignment with Work, Subhang 2026-10-06):
 * every three-mode desktop screen that is not Work renders inside the same
 * chrome Work draws — no top bar, Work's 40px left header, Work's icon rail —
 * so leaving Work never swaps the frame.
 *
 *   [header: mark · space ▾ … View ▾][top band: the screen's items        ]
 *   [rail][panel (optional)        ][content                     ][strip?]
 *
 * The header, the rail and its status cluster are Work's own components; they
 * read `ShellFrameContext`, which this provides outside Work. A rail kind
 * press here goes to Work with that kind's browser (round 1, Q3).
 *
 * Screens fill the slots in two ways: `panel` as a node (a group's MenuRail),
 * or by PORTAL into the hosts `useFrameSlots` exposes (Observe's controls, its
 * counts and its graph actions) — so a screen keeps its own state and no prop
 * has to travel back up through GateApp.
 */
import { createContext, useCallback, useContext, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceGateHandles } from '../tab-workspace/view/context';
import { ShellFrameContext, type ShellFrameValue } from '../tab-workspace/view/context';
import { LeftHeader } from '../tab-workspace/view/LeftHeader';
import { WorkspaceRail } from '../tab-workspace/view/WorkspaceRail';
import { getRailStore } from '../tab-workspace/runtime/railStore';
import { queueWorkArrival } from '../tab-workspace/runtime/arrival';
import { isWorkspaceKind, LAYOUT_BOUNDS } from '../tab-workspace/runtime/types';
import { PanelResizer, usePanelWidth } from '../kit/PanelResizer';
import { VectorIcon } from '../kit/VectorIcon';
import '../tab-workspace/view/workspace.css';
import './app-frame.css';

export interface FrameSlots {
  /** The column beside the rail, when the screen asked for a hosted panel. */
  panel: HTMLElement | null;
  /** The top band's right-hand host (beside the title). */
  top: HTMLElement | null;
  /** The right action strip's top section, when the screen asked for a strip. */
  strip: HTMLElement | null;
}

const NO_SLOTS: FrameSlots = { panel: null, top: null, strip: null };
const FrameSlotsContext = createContext<FrameSlots>(NO_SLOTS);

/** Hosts a framed screen may portal into; all null outside the frame (render inline then). */
export function useFrameSlots(): FrameSlots {
  return useContext(FrameSlotsContext);
}

export interface AppFrameProps {
  gate: WorkspaceGateHandles;
  spaceId: string;
  viewerId: string | null;
  /** The screen's name: the view selector's label off the three modes, and the strip's and panel's accessible names. */
  title: string;
  /** A node for the panel column, `'host'` for an empty portal host, or null for none. */
  panel: ReactNode | 'host' | null;
  /** Draw the right action strip (a portal host plus Expand). */
  strip?: boolean;
  /** Navigate to Work (the rail's kind presses land there). */
  goToWork(): void;
  children: ReactNode;
}

/* Header width when a screen has no panel: Work's default rail + browser. */
const PANEL_MIN = LAYOUT_BOUNDS.browserWidth.min;
const PANEL_DEFAULT = LAYOUT_BOUNDS.browserWidth.initial;

/* "sidebar-show" / "expand", as Work's restore cluster draws them. */
const SIDEBAR_SHOW_ART = ['M2.5 3.5h11v9h-11z', 'M6 3.5v9', 'M3.8 6h1M3.8 8h1'];

export function AppFrame({ gate, spaceId, viewerId, title, panel, strip = false, goToWork, children }: AppFrameProps) {
  const railExpanded = useStore(getRailStore(spaceId), (s) => s.expanded);
  const panelPref = usePanelWidth('frame.panel', PANEL_DEFAULT, PANEL_MIN);
  const panelWidth = Math.min(Math.max(panelPref.width, PANEL_MIN), LAYOUT_BOUNDS.browserWidth.max);
  const [expanded, setExpanded] = useState(false);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [topHost, setTopHost] = useState<HTMLElement | null>(null);
  const [stripHost, setStripHost] = useState<HTMLElement | null>(null);

  const selectKind = useCallback(
    (kind: string) => {
      if (viewerId && isWorkspaceKind(kind)) {
        queueWorkArrival(viewerId, spaceId, { open: [], activate: null, trail: [], browserKind: kind, chat: null });
      }
      goToWork();
    },
    [viewerId, spaceId, goToWork],
  );
  const hasPanel = panel !== null && !expanded;
  const frame = useMemo<ShellFrameValue>(
    () => ({
      gate: { ...gate, screenLabel: title },
      spaceId,
      currentKind: null,
      selectKind,
      /* No panel: the header still spans Work's default width, never narrow. */
      panelWidth: panel !== null ? panelWidth : PANEL_DEFAULT,
    }),
    [gate, title, spaceId, selectKind, panel, panelWidth],
  );
  const slots = useMemo<FrameSlots>(
    () => ({ panel: hasPanel && panel === 'host' ? panelHost : null, top: topHost, strip: strip ? stripHost : null }),
    [hasPanel, panel, panelHost, topHost, strip, stripHost],
  );

  const style = {
    '--tws-browser-w': `${panel !== null ? panelWidth : PANEL_DEFAULT}px`,
    '--tws-rail-w': railExpanded ? 'var(--tws-rail-w-expanded)' : 'var(--tws-rail-w-collapsed)',
  } as CSSProperties;

  return (
    <ShellFrameContext.Provider value={frame}>
      <FrameSlotsContext.Provider value={slots}>
        <div
          className="tws-root app-frame"
          data-panel={hasPanel ? 'on' : 'none'}
          data-strip={strip || undefined}
          data-expanded={expanded || undefined}
          data-rail-expanded={railExpanded || undefined}
          style={style}
          data-testid="app-frame"
        >
          {expanded ? null : <LeftHeader />}
          <div className="app-frame-top" data-testid="app-frame-top">
            {expanded ? (
              <button
                type="button"
                className="tws-icon-btn"
                aria-label="Restore navigation"
                title="Restore navigation"
                onClick={() => setExpanded(false)}
              >
                <VectorIcon paths={SIDEBAR_SHOW_ART} size={16} />
              </button>
            ) : null}
            <div className="app-frame-top-host" ref={setTopHost} />
          </div>
          {expanded ? null : <WorkspaceRail />}
          {hasPanel ? (
            <>
              <div
                className="app-frame-panel"
                data-testid="app-frame-panel"
                data-host={panel === 'host' || undefined}
                ref={panel === 'host' ? setPanelHost : undefined}
              >
                {panel === 'host' ? null : panel}
              </div>
              <div className="tws-resizer">
                <PanelResizer
                  side="left"
                  label={`${title} panel`}
                  width={panelWidth}
                  minWidth={PANEL_MIN}
                  maxWidth={LAYOUT_BOUNDS.browserWidth.max}
                  onResize={panelPref.setWidth}
                  onReset={panelPref.reset}
                />
              </div>
            </>
          ) : null}
          <div className="app-frame-content">{children}</div>
          {strip ? (
            <div className="app-frame-strip" role="toolbar" aria-label={`${title} actions`} data-testid="app-frame-strip">
              <div className="app-frame-strip-top" ref={setStripHost} />
              <div className="app-frame-strip-bottom">
                <button
                  type="button"
                  className="tws-icon-btn app-frame-strip-btn"
                  aria-label={expanded ? 'Restore navigation' : 'Expand'}
                  title={expanded ? 'Restore navigation' : 'Expand'}
                  aria-pressed={expanded}
                  onClick={() => setExpanded((e) => !e)}
                >
                  <span aria-hidden>{expanded ? '⤡' : '⤢'}</span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </FrameSlotsContext.Provider>
    </ShellFrameContext.Provider>
  );
}

