/**
 * The Workspace view root, mounted by GateApp for the `tabs` route
 * (Spec A §3, Spec B §7). Grid: left header | strip over rail | browser |
 * content. Owns the runtime wiring: hooks, persistence, URL sync, dev hook.
 */
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { canCreateKind } from '../adapters/registry';
import { getWorkspaceRuntime } from '../runtime/dispatch';
import { installDevHook } from '../runtime/devHook';
import { initPersistence } from '../runtime/persistence';
import { isWorkspaceKind, type KindId } from '../runtime/types';
import { initUrlSync } from '../runtime/url';
import { NOTICE_TTL_MS } from '../../shell';
import { Browser } from './Browser';
import { ContentHost } from './ContentHost';
import { useWorkspaceStore } from '../runtime/store';
import { WorkspaceProvider, type WorkspaceContextValue, type WorkspaceGateHandles } from './context';
import { LeftHeader } from './LeftHeader';
import { RestoreOffer } from './RestoreOffer';
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

  const style = { '--tws-browser-w': `${layout.browserWidth}px` } as CSSProperties;
  return (
    <WorkspaceProvider value={value}>
      <div className="tws-root" data-expanded={layout.expanded || undefined} style={style} data-testid="tab-workspace">
        {layout.expanded ? null : <LeftHeader />}
        <TabStrip />
        {layout.expanded ? null : <WorkspaceRail />}
        {layout.expanded ? null : <Browser />}
        <ContentHost />
        <RestoreOffer />
        <RevealPrompt />
      </div>
    </WorkspaceProvider>
  );
}
