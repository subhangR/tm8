/**
 * The ONE shared seam every Workspace view component reads (fixed in Wave 0
 * so Wave 1/2 workers never change props across files): the runtime
 * (store + dispatch), the viewer and space, and the GateApp handles.
 */
import { createContext, useContext, type ReactNode } from 'react';
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
  onSelectViewTab(id: string): void;
  /** The existing SpaceSwitcher element, ready to mount. */
  switcherSlot: ReactNode;
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
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
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
