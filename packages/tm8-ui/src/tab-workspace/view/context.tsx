/**
 * The ONE shared seam every Workspace view component reads (fixed in Wave 0
 * so Wave 1/2 workers never change props across files): the runtime
 * (store + dispatch), the viewer and space, and the GateApp handles.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { MenuTarget, Notice, ShellTab } from '../../shell';
import type { DetailReasons } from '../../panels';
import type { NavView } from '../../routes/types';
import type { GateData } from '../../views/useGateData';
import type { WorkspaceRuntime } from '../runtime/dispatch';
import { useWorkspaceStore, type WorkspaceStore } from '../runtime/store';
import type { CommandEnvelope, Result, TypedCommand, WorkspaceState } from '../runtime/types';

/** What GateApp hands the Workspace view (Spec B §7 "GateApp"). */
export interface WorkspaceGateHandles {
  /** The data seam: viewer, space, members, entity reads, events, commands. */
  data: GateData;
  reasons: DetailReasons;
  serverBaseUrl: string | undefined;
  viewerMemberId: string | null;
  onNotice(notice: Notice): void;
  /** Opens the existing ⌘K palette. */
  openPalette(): void;
  /** Navigate to a menu target (leaves Workspace for other views). */
  navigateTo(target: MenuTarget): void;
  /** Write a route view directly (route-only views such as `boardV2`). */
  navigateView(view: NavView): void;
  /** The tm8 mark. */
  goHome(): void;
  openInbox(): void;
  /** The view selector (Work · Design · Observe, D31) and the other shell tabs (Design, Settings, Help…). */
  viewTabs: ShellTab[];
  shellTabs: ShellTab[];
  activeViewTabId: string | null;
  /** The view the shell shows (`inbox`, `settings`, `files`…), or null on an entity: the rail's screens read current off it. */
  activeScreenRef?: string | null | undefined;
  onSelectViewTab(id: string): void;
  /** The existing SpaceSwitcher element, ready to mount. */
  switcherSlot: ReactNode;
  /** The screen's name when it is not one of the three modes (Inbox, Messages…): the view selector's label. */
  screenLabel?: string | undefined;
  /** The existing AccountMenu element (with Inbox and Copy link rows), or undefined without an account. */
  accountSlot: ReactNode;
}

export interface WorkspaceContextValue {
  runtime: WorkspaceRuntime;
  store: WorkspaceStore;
  dispatch(env: CommandEnvelope | TypedCommand): Result;
  viewerId: string;
  spaceId: string;
  gate: WorkspaceGateHandles;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ value, children }: { value: WorkspaceContextValue; children: ReactNode }) {
  return (
    <WorkspaceContext.Provider value={value}>
      <WorkspaceFrame value={value}>{children}</WorkspaceFrame>
    </WorkspaceContext.Provider>
  );
}

/**
 * THE SHARED FRAME (chat + Observe shell alignment, 2026-10-06): the left
 * header, the icon rail and its status cluster read THIS, not the Work store,
 * so every desktop screen mounts the same chrome. Work provides it from its
 * store (below); every other screen gets it from `AppFrame` (shell/).
 */
export interface ShellFrameValue {
  gate: WorkspaceGateHandles;
  spaceId: string;
  /** The kind Work's browser shows; null outside Work (no rail kind reads current). */
  currentKind: string | null;
  /** A rail kind press: Work swaps its browser; elsewhere it goes to Work with that browser. */
  selectKind(kind: string): void;
  /** Width of the column beside the rail (Work's browser, a screen's panel). */
  panelWidth: number;
}

export const ShellFrameContext = createContext<ShellFrameValue | null>(null);

export function useShellFrame(): ShellFrameValue {
  const value = useContext(ShellFrameContext);
  if (!value) throw new Error('useShellFrame must be used inside TabWorkspaceView or AppFrame');
  return value;
}

function WorkspaceFrame({ value, children }: { value: WorkspaceContextValue; children: ReactNode }) {
  const currentKind = useWorkspaceStore(value.store, (s) => s.browsers.main.kind);
  const panelWidth = useWorkspaceStore(value.store, (s) => s.layout.browserWidth);
  const { dispatch, gate, spaceId } = value;
  const frame = useMemo<ShellFrameValue>(
    () => ({
      gate,
      spaceId,
      currentKind,
      panelWidth,
      selectKind: (kind) => dispatch({ command: 'workspace.browser.set', args: { browserId: 'main', kind }, source: 'click' }),
    }),
    [gate, spaceId, currentKind, panelWidth, dispatch],
  );
  return <ShellFrameContext.Provider value={frame}>{children}</ShellFrameContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside TabWorkspaceView');
  return value;
}

/** Subscribe to a slice of the mounted workspace state. */
export function useWorkspaceState<T>(selector: (state: WorkspaceState) => T): T {
  return useWorkspaceStore(useWorkspace().store, selector);
}
