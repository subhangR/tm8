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
import { Navigator } from '../tab-workspace/view/Navigator';
import { browserBounds, isNavigatorEnabled, isPinnedRailEnabled } from '../tab-workspace/view/navigatorFlag';
import { PanelTop } from '../tab-workspace/view/Browser';
import { ShowPanel } from '../tab-workspace/view/TabWorkspaceView';
import { WorkspaceRail } from '../tab-workspace/view/WorkspaceRail';
import { queueWorkKey } from '../tab-workspace/keys';
import { getRailStore } from '../tab-workspace/runtime/railStore';
import { queueWorkArrival } from '../tab-workspace/runtime/arrival';
import { getBrowserSourceStore } from '../tab-workspace/runtime/browserSourceStore';
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
  /** The frame's Expand (rail, panel and header hidden), for a screen that draws its own Expand. */
  expanded: boolean;
  setExpanded?: ((expanded: boolean) => void) | undefined;
}

const NO_SLOTS: FrameSlots = { panel: null, top: null, strip: null, expanded: false };
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
  /**
   * WHERE `panel` GOES WITH THE NAVIGATOR ON (design doc §9).
   *
   * `'slot'` (the default) puts it in the navigator's lower area: a framed
   * screen's own nav (Settings' `FrameNav`) IS that mode's list, so it belongs
   * where Work's kind tree goes and the screen loses a whole column of chrome.
   *
   * `'column'` keeps it beside the navigator, which is Craft phase 1:
   * `CraftSidePanel` is a WORKING surface — a chat pane or a live terminal —
   * not a list, so putting it in the slot would be phase 2's layout shipped by
   * accident. Craft passes this with `navCollapsed`, and looks exactly as it
   * does today.
   */
  panelPlacement?: 'slot' | 'column';
  /** With the navigator on and nothing chosen yet, start it collapsed (Craft, §9). */
  navCollapsedDefault?: boolean;
  /**
   * THE PINNED-ONLY RAIL'S SHELL (`tm8.ui.navigator = 'rail'`), per mode: the
   * mode's id, set by a mode brought to Work's pinned-rail layout — full-height
   * rail, no left header, the panel headed by Work's `PanelTop`. A mode that
   * passes nothing keeps the frame it has.
   */
  pinnedMode?: string;
  children: ReactNode;
}

/*
 * Header width when a screen has no panel: Work's default left columns.
 *
 * READ IN THE COMPONENT, not at module scope: `browserBounds()` touches
 * localStorage, and a module-level read runs at import time — before a test or
 * a harness has had any chance to set the flag, and in whatever environment
 * imports this file first.
 */
function panelBounds() {
  const bounds = browserBounds();
  return { min: bounds.min, initial: bounds.initial, max: LAYOUT_BOUNDS.browserWidth.max };
}

/* "sidebar-show" / "expand", as Work's restore cluster draws them. */
const SIDEBAR_SHOW_ART = ['M2.5 3.5h11v9h-11z', 'M6 3.5v9', 'M3.8 6h1M3.8 8h1'];

export function AppFrame({
  gate,
  spaceId,
  viewerId,
  title,
  panel,
  strip = false,
  goToWork,
  panelPlacement = 'slot',
  navCollapsedDefault = false,
  pinnedMode,
  children,
}: AppFrameProps) {
  const railExpanded = useStore(getRailStore(spaceId), (s) => s.expanded);
  const navigator = useMemo(() => isNavigatorEnabled(), []);
  const navCollapsedStored = useStore(getRailStore(spaceId), (s) => s.collapsed);
  const navCollapsed = navigator && (navCollapsedStored ?? navCollapsedDefault);
  const pinnedRail = useMemo(() => isPinnedRailEnabled(), []) && pinnedMode !== undefined;
  const panelCollapsed = pinnedRail && (navCollapsedStored ?? false);
  const { min: PANEL_MIN, initial: PANEL_DEFAULT, max: PANEL_MAX } = useMemo(panelBounds, []);
  const panelPref = usePanelWidth('frame.panel', PANEL_DEFAULT, PANEL_MIN);
  const panelWidth = Math.min(Math.max(panelPref.width, PANEL_MIN), PANEL_MAX);
  const [expanded, setExpanded] = useState(false);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [topHost, setTopHost] = useState<HTMLElement | null>(null);
  const [stripHost, setStripHost] = useState<HTMLElement | null>(null);

  const selectKind = useCallback(
    (kind: string) => {
      if (viewerId && isWorkspaceKind(kind)) {
        getBrowserSourceStore(spaceId).getState().setSource(null);
        queueWorkArrival(viewerId, spaceId, { open: [], activate: null, trail: [], browserKind: kind, chat: null });
      }
      goToWork();
    },
    [viewerId, spaceId, goToWork],
  );
  /* ＋ New from a framed screen: no Work runtime is mounted here, so the
     create is QUEUED and we navigate — `keys.ts`'s own mechanism for a command
     that makes sense from anywhere. */
  const createKind = useCallback(
    (kind: string) => {
      queueWorkKey({ command: 'work.create', ref: kind });
      goToWork();
    },
    [goToWork],
  );
  const selectSource = useCallback(
    (sourceId: string) => {
      getBrowserSourceStore(spaceId).getState().setSource(sourceId);
      goToWork();
    },
    [spaceId, goToWork],
  );
  const hasPanel = panel !== null && !expanded && !panelCollapsed;
  /* Whether the panel renders inside the navigator's lower area (§9). */
  const inSlot = navigator && hasPanel && panelPlacement === 'slot';
  const panelEl = hasPanel ? (
    <div
      className={pinnedRail ? 'tws-browser app-frame-panel' : 'app-frame-panel'}
      data-testid="app-frame-panel"
      data-host={panel === 'host' || undefined}
      data-in-nav={inSlot || undefined}
      ref={panel === 'host' && !pinnedRail ? setPanelHost : undefined}
    >
      {pinnedRail ? <PanelTop searchable /> : null}
      {/* A portal host under PanelTop gets its own box (Observe's controls):
          portalled children would otherwise land beside the row, not below it. */}
      {panel !== 'host' ? panel : pinnedRail ? <div className="app-frame-panel-host" ref={setPanelHost} /> : null}
    </div>
  ) : null;
  const frame = useMemo<ShellFrameValue>(
    () => ({
      gate: { ...gate, screenLabel: title },
      spaceId,
      currentKind: null,
      currentSource: null,
      selectKind,
      selectSource,
      createKind,
      /* No panel: the header still spans Work's default width, never narrow. */
      panelWidth: panel !== null ? panelWidth : PANEL_DEFAULT,
    }),
    [gate, title, spaceId, selectKind, selectSource, createKind, panel, panelWidth],
  );
  const slots = useMemo<FrameSlots>(
    () => ({
      panel: hasPanel && panel === 'host' ? panelHost : null,
      top: topHost,
      strip: strip ? stripHost : null,
      expanded,
      setExpanded,
    }),
    [hasPanel, panel, panelHost, topHost, strip, stripHost, expanded],
  );

  const style = {
    '--tws-browser-w': `${panel !== null ? panelWidth : PANEL_DEFAULT}px`,
    /* The navigator's own track. It follows the panel width when the panel is
       IN it, and otherwise keeps its default — a Craft panel drag must not
       also widen the strip beside it. */
    '--tws-nav-w': navCollapsed
      ? 'var(--tws-rail-w-collapsed)'
      : `${inSlot || !hasPanel ? panelWidth : PANEL_DEFAULT}px`,
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
          data-nav={navigator || undefined}
          data-nav-collapsed={navCollapsed || undefined}
          data-nav-panel={inSlot ? 'slot' : undefined}
          data-rail-expanded={railExpanded || undefined}
          data-pinned-rail={pinnedRail ? pinnedMode : undefined}
          data-panel-collapsed={panelCollapsed || undefined}
          style={style}
          data-testid="app-frame"
        >
          {expanded || pinnedRail ? null : <LeftHeader />}
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
            ) : panelCollapsed ? (
              <ShowPanel spaceId={spaceId} />
            ) : null}
            {/* Pinned: the mode's own switcher leads the band, as the
                workspace switcher leads Work's strip (Craft's crafts ▾). */}
            {pinnedRail && !expanded && gate.modeSwitcherSlot ? (
              <div className="tws-mode-switcher-slot" data-testid="tws-mode-switcher-slot">{gate.modeSwitcherSlot}</div>
            ) : null}
            <div className="app-frame-top-host" ref={setTopHost} />
          </div>
          {expanded ? null : navigator ? (
            <Navigator
              slot={inSlot ? panelEl : null}
              collapsedDefault={navCollapsedDefault}
            />
          ) : (
            <WorkspaceRail />
          )}
          {/* The panel keeps its own column when there is no navigator, and
              when the navigator is on but the screen asked for `column`
              (Craft phase 1 — `CraftSidePanel` exactly as today). */}
          {hasPanel && !inSlot ? panelEl : null}
          {/*
            ONE RESIZER, on the column the drag actually widens. Both columns
            ride the same stored `frame.panel` width, so drawing a handle on
            each would be two handles writing one number — and the second one
            would silently resize the first column. In the slot the navigator
            IS the panel and the handle is the navigator's; beside it (Craft)
            the handle stays the panel's and the navigator keeps the 48px strip
            it starts in.
          */}
          {expanded || panelCollapsed || (navigator && navCollapsed && !hasPanel) ? null : (
            <div className={inSlot || (navigator && !navCollapsed && !hasPanel) ? 'tws-resizer tws-nav-resizer' : 'tws-resizer'}>
              <PanelResizer
                side="left"
                label={inSlot ? 'Navigator' : `${title} panel`}
                width={panelWidth}
                minWidth={PANEL_MIN}
                maxWidth={PANEL_MAX}
                onResize={panelPref.setWidth}
                onReset={panelPref.reset}
              />
            </div>
          )}
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

