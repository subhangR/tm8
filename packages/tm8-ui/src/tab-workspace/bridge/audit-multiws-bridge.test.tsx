// @vitest-environment jsdom
/**
 * AUDIT (task 01a1181c, 2026-10-07) — FAILING tests for the window bridge and
 * the switcher (PR #1103, e71efecdc). Each test states the behaviour the
 * design asks for; on e71efecdc every one FAILS. Ids match the findings doc.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toStoredState, type WorkspaceState } from '@tm8/contract/workspace';
import type { WorkspaceListResult, WorkspaceManageResult, WorkspaceSummary } from '@tm8/contract';

import type { WorkspaceBridgePort, WorkspaceManagePort } from '../../data/seam';
import type { WorkspaceSyncFrame } from '../../data/real/socket';
import { getRailStore } from '../runtime/railStore';
import { createWorkspaceStore } from '../runtime/store';
import { WorkspaceSwitcher } from '../view/WorkspaceSwitcher';
import { useWorkspaceBridge, type BridgeDialogControl } from './useWorkspaceBridge';
import { createWorkspaceListStore, getWorkspaceListStore, openWorkspaceSwitcher } from './workspaceList';

const summary = (id: string, name: string, position = 0, active = false): WorkspaceSummary => ({
  id, name, color: null, position, active, revision: 1, tabCount: 0, draftCount: 0, dirtyDraftCount: 0,
  createdAt: null, createdBy: null, agentChangedSinceActive: false, lastAgentChange: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A fake events socket + management port; `emit` delivers a node frame to every live subscriber. */
function fakePort() {
  const syncs = new Set<(frame: WorkspaceSyncFrame) => void>();
  const lists = new Map<string, ReturnType<typeof deferred<WorkspaceListResult>>>();
  const manage = {
    list: vi.fn((spaceId: string) => {
      const d = deferred<WorkspaceListResult>();
      lists.set(spaceId, d);
      return d.promise;
    }),
  } as unknown as WorkspaceManagePort;
  const port: WorkspaceBridgePort = {
    send: () => true,
    onCommand: () => () => {},
    onOpen: () => () => {},
    onSync: (cb) => { syncs.add(cb); return () => void syncs.delete(cb); },
    isOpen: () => true,
    onStatus: () => () => {},
    manage,
  };
  const emit = (frame: unknown) => { for (const cb of [...syncs]) cb(frame as WorkspaceSyncFrame); };
  return { port, emit, lists };
}

const control = (): BridgeDialogControl => ({ open: false, setOpen: () => {}, available: false });
const dialogs = { palette: control(), prompts: control(), agentTools: control(), newSpace: control(), addServer: control() };
const listOf = (items: WorkspaceSummary[], listRevision: number, activeWorkspaceId: string): WorkspaceListResult =>
  ({ items, listRevision, activeWorkspaceId, cap: 20, prompts: [] });
const empty = (spaceId: string): WorkspaceState => toStoredState(createWorkspaceStore('audit-empty', spaceId).getState());
const stateFrame = (spaceId: string, workspaceId: string, revision: number, state: WorkspaceState) =>
  ({ type: 'workspace.state', spaceId, workspaceId, active: true, revision, state: { ...state, revision } });

let viewer = 0;
function mountBridge(port: WorkspaceBridgePort, spaceId: string) {
  viewer += 1;
  const viewerId = `audit-bridge-viewer-${viewer}`;
  const hook = renderHook(
    ({ space }: { space: string }) => useWorkspaceBridge({
      port, spaceId: space, viewerId, view: 'tabs', dialogs, otherModalOpen: false,
      showWorkspace: () => {}, titleOf: () => undefined, notify: () => {},
    }),
    { initialProps: { space: spaceId } },
  );
  return { ...hook, viewerId };
}

afterEach(() => vi.useRealTimers());

describe('AUDIT F21 — a list response from the previous space lands in the new space’s switcher', () => {
  it('space A → B while A’s workspace.list is in flight: B’s switcher shows A’s workspaces', async () => {
    const { port, emit, lists } = fakePort();
    const { rerender, viewerId } = mountBridge(port, 'space-A');
    act(() => emit(stateFrame('space-A', 'a1', 1, empty('space-A'))));
    expect(lists.has('space-A')).toBe(true);
    rerender({ space: 'space-B' });
    act(() => emit(stateFrame('space-B', 'b1', 1, empty('space-B'))));
    expect(lists.has('space-B')).toBe(true);
    await act(async () => {
      lists.get('space-A')!.resolve(listOf([summary('a1', 'Alpha', 0, true)], 9, 'a1'));
      lists.get('space-B')!.resolve(listOf([summary('b1', 'Beta', 0, true)], 2, 'b1'));
    });
    expect(getWorkspaceListStore(viewerId, 'space-B').getState().items.map((w) => w.name)).toEqual(['Beta']);
  });
});

describe('AUDIT F22 — switching to a workspace with no stored rail keeps the previous one’s rail', () => {
  it('Main has a customised rail; a new workspace (no rail) shows Main’s pins instead of the defaults', () => {
    const { port, emit } = fakePort();
    const space = `space-rail-${viewer + 1}`;
    mountBridge(port, space);
    const main = { ...empty(space), rail: { pins: ['doc'], open: {}, expanded: true } } as WorkspaceState;
    act(() => emit(stateFrame(space, 'm1', 1, main)));
    expect(getRailStore(space).getState().pins).toEqual(['doc']);
    // The human switches to a freshly created workspace: defaultWorkspaceState has no rail.
    act(() => {
      emit({ type: 'workspace.switched', spaceId: space, workspaceId: 'w2', previousWorkspaceId: 'm1', listRevision: 2, at: '2026-10-07T00:00:00Z' });
      emit(stateFrame(space, 'w2', 1, empty(space)));
    });
    expect(getRailStore(space).getState().pins).toEqual(['chat', 'task', 'work_session']);
    expect(getRailStore(space).getState().expanded).toBe(false);
  });
});

function switcher(items = [summary('w1', 'Main', 0, true), summary('w2', 'Billing', 1)]) {
  const store = createWorkspaceListStore({ capable: true, online: true, shown: 'w1', activeWorkspaceId: 'w1', items });
  const pending = deferred<WorkspaceManageResult>();
  const manage = { create: vi.fn(() => pending.promise), switch: vi.fn(async () => ({ status: 'applied' })) } as unknown as WorkspaceManagePort;
  const view = render(<WorkspaceSwitcher store={store} spaceId="s1" manage={manage} notify={() => {}} />);
  return { store, manage, view };
}

describe('AUDIT F23 — switcher keyboard and in-flight guards', () => {
  it('F23a: a plain key on the "＋ New workspace" footer reaches the shell shortcuts (w closes the tab behind the popover)', () => {
    const { store } = switcher();
    act(() => void store.setState({ open: true }));
    const leaked: string[] = [];
    const shell = (event: KeyboardEvent) => { if (!event.defaultPrevented) leaked.push(event.key); };
    window.addEventListener('keydown', shell);
    try {
      const footer = screen.getByRole('button', { name: /New workspace/ });
      footer.focus();
      fireEvent.keyDown(footer, { key: 'w' });
    } finally {
      window.removeEventListener('keydown', shell);
    }
    expect(leaked).toEqual([]);
  });

  it('F23b: a double click on "＋ New workspace" creates two workspaces', () => {
    const { store, manage } = switcher();
    act(() => void store.setState({ open: true }));
    const footer = screen.getByRole('button', { name: /New workspace/ });
    fireEvent.click(footer);
    fireEvent.click(footer);
    expect(manage.create).toHaveBeenCalledTimes(1);
  });

  it('F23c: g w with no switcher mounted (navigation hidden) leaves open=true, and the popover pops up later on its own', () => {
    const store = createWorkspaceListStore({ capable: true, online: true, shown: 'w1', activeWorkspaceId: 'w1', items: [summary('w1', 'Main', 0, true)] });
    // The chord's handler runs while no WorkspaceSwitcher is in the tree…
    expect(openWorkspaceSwitcher(store, () => {})).toBe(true);
    // …later the navigation is restored and the switcher mounts.
    render(<WorkspaceSwitcher store={store} spaceId="s1" manage={undefined} notify={() => {}} />);
    expect(screen.queryByRole('dialog', { name: 'Switch workspace' })).toBeNull();
  });
});
