/**
 * CRAFT WORKSPACES, CLIENT SIDE (Craft redesign doc 01a1255d §3 "Persistence").
 *
 * A craft is shared by the space; the TABS a person has open on it are theirs:
 * one hidden workspace per (space, identity, craft), read with
 * `workspace.crafts.get`, changed with `workspace.crafts.command`, and pushed
 * to the person's own windows as a `craft.workspace` frame after every commit
 * (lane L3, `@tm8/contract` craft-workspace.ts). The wire types are the
 * contract's; the seam port is `seam.craftWorkspaces` (data/seam.ts).
 *
 * What lives here: the tab commands as a pure function (the window's
 * optimistic step) and an in-memory port for seams that have none.
 */
import {
  CRAFT_OPEN_CAP,
  CRAFT_WORKSPACE_TAB_CAP,
  craftTabKind,
  defaultCraftWorkspaceState,
  type CraftTab,
  type CraftTabRef,
  type CraftWorkspace,
  type CraftWorkspaceCommandArgsMap,
  type CraftWorkspaceCommandResult,
  type CraftWorkspaceFrame,
  type CraftWorkspaceResultReason,
  type CraftWorkspaceState,
} from '@tm8/contract';
import type { CraftWorkspacesPort } from './seam';
import type { CraftWorkspacePushFrame } from './real/socket';

/** The commands the tab strip sends: the `tabs.*` ones (the top bar owns `craft.*`). */
export type CraftTabCommand = 'tabs.open' | 'tabs.close' | 'tabs.move' | 'tabs.activate';
export type CraftTabCommandArgs = Pick<CraftWorkspaceCommandArgsMap, CraftTabCommand>;

function isTabCommand(command: string): command is CraftTabCommand {
  return command === 'tabs.open' || command === 'tabs.close' || command === 'tabs.move' || command === 'tabs.activate';
}

/** A craft's default workspace: the overview, alone and selected. */
export function defaultCraftWorkspace(craftId: string): CraftWorkspace {
  return {
    workspaceId: null,
    craftId,
    revision: 0,
    open: false,
    position: 0,
    state: defaultCraftWorkspaceState(craftId),
    updatedAt: null,
    lastAgentChange: null,
  };
}

function newTabId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function findTab(state: CraftWorkspaceState, ref: CraftTabRef): CraftTab | undefined {
  return 'tabId' in ref ? state.tabs.find((t) => t.id === ref.tabId) : state.tabs.find((t) => t.entityId === ref.entityId);
}

/**
 * The tab commands as a pure function: what the node does to the stored
 * state, used by the memory port and for the window's optimistic step.
 * `isPage` says whether an entity is one of the craft's own pages
 * (`not_a_page` otherwise); absent ⇒ every entity is allowed.
 */
export function applyCraftTabCommand(
  workspace: CraftWorkspace,
  command: CraftTabCommand,
  args: CraftTabCommandArgs[CraftTabCommand],
  isPage?: (entityId: string) => boolean,
): Omit<CraftWorkspaceCommandResult, 'requestId'> {
  const state = workspace.state;
  const done = (next: CraftWorkspaceState, extra: Partial<CraftWorkspaceCommandResult> = {}) => ({
    status: 'applied' as const,
    ...extra,
    workspace: { ...workspace, revision: workspace.revision + 1, state: next, updatedAt: new Date().toISOString() },
  });
  const refuse = (reason: CraftWorkspaceResultReason) => ({ status: 'rejected' as const, reason, workspace });
  switch (command) {
    case 'tabs.open': {
      const a = args as CraftTabCommandArgs['tabs.open'];
      const kind = craftTabKind(a.kind);
      if (!kind) return refuse('unsupported_kind');
      const existing = state.tabs.find((t) => t.entityId === a.entityId);
      if (existing) {
        if (a.activate === false || state.activeTabId === existing.id) return { status: 'no_op', tabId: existing.id, outcome: 'reused', workspace };
        return done({ ...state, activeTabId: existing.id }, { tabId: existing.id, outcome: 'reused' });
      }
      if (isPage && !isPage(a.entityId)) return refuse('not_a_page');
      if (state.tabs.length >= CRAFT_WORKSPACE_TAB_CAP) return refuse('tab_limit');
      const tab: CraftTab = { id: newTabId(), kind, entityId: a.entityId, pinned: false };
      const tabs = [...state.tabs];
      const before = a.beforeTabId ? tabs.findIndex((t) => t.id === a.beforeTabId) : -1;
      tabs.splice(before > 0 ? before : tabs.length, 0, tab);
      return done({ tabs, activeTabId: a.activate === false ? state.activeTabId : tab.id }, { tabId: tab.id, outcome: 'created' });
    }
    case 'tabs.close': {
      const tab = findTab(state, args as CraftTabRef);
      if (!tab) return refuse('tab_not_found');
      if (tab.pinned) return refuse('pinned');
      const at = state.tabs.indexOf(tab);
      const tabs = state.tabs.filter((t) => t !== tab);
      const activeTabId = state.activeTabId === tab.id ? (tabs[at] ?? tabs[at - 1] ?? tabs[0]!).id : state.activeTabId;
      return done({ tabs, activeTabId }, { tabId: tab.id });
    }
    case 'tabs.move': {
      const a = args as CraftTabCommandArgs['tabs.move'];
      const tab = findTab(state, a);
      if (!tab) return refuse('tab_not_found');
      if (tab.pinned || a.beforeTabId === state.tabs[0]!.id) return refuse('pinned');
      const tabs = state.tabs.filter((t) => t !== tab);
      const before = a.beforeTabId === null ? tabs.length : tabs.findIndex((t) => t.id === a.beforeTabId);
      if (before < 0) return refuse('tab_not_found');
      tabs.splice(before, 0, tab);
      if (tabs.every((t, i) => t === state.tabs[i])) return { status: 'no_op', tabId: tab.id, workspace };
      return done({ ...state, tabs }, { tabId: tab.id });
    }
    case 'tabs.activate': {
      const tab = findTab(state, args as CraftTabRef);
      if (!tab) return refuse('tab_not_found');
      if (state.activeTabId === tab.id) return { status: 'no_op', tabId: tab.id, workspace };
      return done({ ...state, activeTabId: tab.id }, { tabId: tab.id });
    }
  }
}

/**
 * An in-memory port for a seam with no craft workspaces (fixtures, harness
 * mounts): the same tab rules, kept for this page's life, pushed to its own
 * subscribers as the node pushes to a person's windows. Tabs only: the
 * `craft.*` commands (the top bar's) are refused here.
 */
export function memoryCraftWorkspacesPort(): CraftWorkspacesPort {
  const rows = new Map<string, CraftWorkspace>();
  const subs = new Set<(frame: CraftWorkspacePushFrame) => void>();
  const key = (spaceId: string, craftId: string) => `${spaceId}/${craftId}`;
  return {
    async list(spaceId) {
      const items = [...rows.entries()].filter(([k]) => k.startsWith(`${spaceId}/`)).map(([, row]) => row);
      return { items, openCap: CRAFT_OPEN_CAP };
    },
    async get(spaceId, craftId) {
      return rows.get(key(spaceId, craftId)) ?? defaultCraftWorkspace(craftId);
    },
    async command(spaceId, craftId, input) {
      const was = rows.get(key(spaceId, craftId)) ?? defaultCraftWorkspace(craftId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== was.revision) {
        return { requestId: input.requestId, status: 'conflict', reason: 'revision_conflict', workspace: was };
      }
      if (!isTabCommand(input.command)) {
        return { requestId: input.requestId, status: 'rejected', reason: 'invalid_arguments', workspace: was };
      }
      const result = applyCraftTabCommand(was, input.command, input.args as CraftTabCommandArgs[CraftTabCommand]);
      if (result.status === 'applied') {
        rows.set(key(spaceId, craftId), result.workspace);
        const frame: CraftWorkspaceFrame = { type: 'craft.workspace', spaceId, workspace: result.workspace };
        for (const cb of subs) cb(frame);
      }
      return { requestId: input.requestId, ...result };
    },
    onPush(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}
