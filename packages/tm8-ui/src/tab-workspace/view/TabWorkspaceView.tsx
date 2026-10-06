/**
 * The Workspace view root, mounted by GateApp for the `tabs` route
 * (Spec A §3, Spec B §7). Grid: left header | strip over rail | browser |
 * content. Owns the runtime wiring: hooks, persistence, URL sync, dev hook.
 */
import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { canCreateKind } from '../adapters/registry';
import { getWorkspaceRuntime } from '../runtime/dispatch';
import { installDevHook } from '../runtime/devHook';
import { initPersistence } from '../runtime/persistence';
import { initUrlSync } from '../runtime/url';
import { NOTICE_TTL_MS } from '../../shell';
import { PanelResizer } from '../../kit/PanelResizer';
import { VectorIcon } from '../../kit/VectorIcon';
import { isWorkspaceKind, LAYOUT_BOUNDS, type KindId } from '../runtime/types';
import { Browser } from './Browser';
import { ContentHost } from './ContentHost';
import { useWorkspaceStore } from '../runtime/store';
import { WorkspaceProvider, useWorkspace, type WorkspaceContextValue, type WorkspaceGateHandles } from './context';
import { LeftHeader, ViewSelector } from './LeftHeader';
import { ScopeRepairBanner } from './RestoreOffer';
import { RevealPrompt } from './RevealPrompt';
import { TabStrip } from './TabStrip';
import { WorkspaceRail } from './WorkspaceRail';
import './workspace.css';

export interface TabWorkspaceViewProps {
  viewerId: string;
  spaceId: string;
  /** The route's `?tab=` entity id, if any. */
  routeTab?: string | undefined;
  gate: WorkspaceGateHandles;
}

export function TabWorkspaceView({ viewerId, spaceId, routeTab, gate }: TabWorkspaceViewProps) {
  const runtime = useMemo(() => getWorkspaceRuntime(viewerId, spaceId), [viewerId, spaceId]);
  const layout = useWorkspaceStore(runtime.store, (s) => s.layout);

  const { onNotice, navigateView } = gate;
  useEffect(
    () =>
      runtime.setHooks({
        canCreate: canCreateKind,
        /* Spec C: tab/scope/layout commands from the bridge need this view. */
        viewMounted: () => true,
        toast: (toast) =>
          onNotice({ id: `tws-${Date.now()}`, tone: 'info', title: toast.text, body: '', ttlMs: NOTICE_TTL_MS }),
      }),
    [runtime, onNotice],
  );
  useEffect(() => installDevHook(runtime), [runtime]);
  useEffect(() => initPersistence(runtime, { viewerId, spaceId }), [runtime, viewerId, spaceId]);
  /* The URL carries only an entity id; its kind comes from the data layer.
     A cold id is fetched once and polled briefly (the read lands in `data`). */
  const dataRef = useRef(gate.data);
  dataRef.current = gate.data;
  const resolveKind = useMemo(
    () =>
      async (entityId: string): Promise<KindId | undefined> => {
        const kindNow = () => {
          const kind = dataRef.current.detailOf(entityId)?.kind;
          return isWorkspaceKind(kind) ? kind : undefined;
        };
        if (kindNow()) return kindNow();
        dataRef.current.refetchDetail(entityId);
        for (let waited = 0; waited < 8000; waited += 200) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (kindNow()) return kindNow();
        }
        return undefined;
      },
    [],
  );
  useEffect(
    () => initUrlSync(runtime, { viewerId, spaceId, routeTab, navigateView, resolveKind }),
    // routeTab is read at mount; later changes arrive through hashchange (workstream I).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime, viewerId, spaceId, navigateView, resolveKind],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({ runtime, store: runtime.store, dispatch: runtime.dispatch, viewerId, spaceId, gate }),
    [runtime, viewerId, spaceId, gate],
  );

  const setBrowserWidth = useCallback(
    (browserWidth: number) =>
      runtime.dispatch({ command: 'workspace.layout.set', args: { browserWidth: Math.round(browserWidth) }, source: 'click' }),
    [runtime],
  );

  const style = { '--tws-browser-w': `${layout.browserWidth}px` } as CSSProperties;
  return (
    <WorkspaceProvider value={value}>
      <div className="tws-root" data-expanded={layout.expanded || undefined} style={style} data-testid="tab-workspace">
        {layout.expanded ? null : <LeftHeader />}
        <TabStrip leading={layout.expanded ? <RestoreNavigation /> : undefined} />
        {layout.expanded ? null : <WorkspaceRail />}
        {layout.expanded ? null : <Browser />}
        {layout.expanded ? null : (
          <div className="tws-resizer">
            <PanelResizer
              side="left"
              label="Workspace browser"
              width={layout.browserWidth}
              minWidth={LAYOUT_BOUNDS.browserWidth.min}
              maxWidth={LAYOUT_BOUNDS.browserWidth.max}
              onResize={setBrowserWidth}
              onReset={() => setBrowserWidth(LAYOUT_BOUNDS.browserWidth.initial)}
            />
          </div>
        )}
        <ContentHost />
        <ScopeRepairBanner />
        <RevealPrompt />
      </div>
    </WorkspaceProvider>
  );
}

/* "sidebar-show": a panel outline with its left column drawn in. */
const SIDEBAR_SHOW_ART = ['M2.5 3.5h11v9h-11z', 'M6 3.5v9', 'M3.8 6h1M3.8 8h1'];

/** Spec A §14: the strip's far-left cluster while the navigation is expanded away. */
function RestoreNavigation() {
  const { dispatch } = useWorkspace();
  return (
    <div className="tws-restore" role="group" aria-label="Navigation">
      <button
        type="button"
        className="tws-icon-btn"
        aria-label="Restore navigation"
        title="Restore navigation"
        data-testid="tws-restore"
        onClick={() => dispatch({ command: 'workspace.layout.set', args: { expanded: false }, source: 'click' })}
      >
        <VectorIcon paths={SIDEBAR_SHOW_ART} size={16} />
      </button>
      <ViewSelector variant="more" />
    </div>
  );
}
