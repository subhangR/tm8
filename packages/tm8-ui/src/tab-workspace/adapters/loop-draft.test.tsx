// @vitest-environment jsdom
/**
 * New loop in the Workspace (loops design §6): the draft tab draws the loop
 * form IN the tab — not as a modal over the whole workspace — and the create
 * binds the tab to the new loop, so it opens in the centre.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceId } from '@tm8/contract';
import { createFixtureLoopsClient } from '../../loops/fixture';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { ContentHost } from '../view/ContentHost';
import { WorkspaceContext, type WorkspaceContextValue } from '../view/context';

vi.mock('../view/LinkedTrail', () => ({ LinkedTrail: () => null, useLinkedOpen: () => ({ openLinked: () => {}, openTab: () => {} }) }));
vi.mock('../view/ChatDock', () => ({ ChatDock: () => null }));
vi.mock('../view/ActionStrip', () => ({ ActionStrip: () => null }));
vi.mock('../../views/useLaunchPort', () => ({ useLaunchPort: () => ({}) }));
vi.mock('../../views/usePanelPrimaries', () => ({ usePanelPrimaries: () => ({ dialog: null, forEntity: () => undefined, wiredActions: [] }) }));
vi.mock('../../views/useRowLifecycle', () => ({ useRowLifecycle: () => ({}) }));
vi.mock('../../views/membershipSurface', () => ({ useMembershipSurface: () => ({ authoringFor: () => null }) }));
vi.mock('../../views/useEntityVerbs', () => ({
  useEntityVerbs: () => ({ onAction: () => {}, wiredActions: [], edit: null, editFields: [], editTitle: '' }),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const SPACE = '00000000-0000-4000-8000-000000000001';

function openLoopDraft() {
  const loops = createFixtureLoopsClient();
  const store = createWorkspaceStore('viewer-1', SPACE);
  const runtime = createWorkspaceRuntime('viewer-1', SPACE, store);
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false, toast: vi.fn() });
  const loopForm = {
    query: async () => ({ page: { items: [], nextCursor: null } }),
    entity: () => new Promise(() => {}),
  };
  const data = {
    /* The created loop's detail never answers here: the bound tab stays on its loading frame. */
    seam: { entity: () => new Promise(() => {}), commands: { loops, loopForm } },
    spaceId: SPACE,
    skillOptions: [],
    detailOf: () => undefined,
    pull: vi.fn(),
    refetchDetail: vi.fn(),
    livenessOf: () => 'unknown',
  };
  const value = {
    runtime,
    store,
    dispatch: (env: never) => runtime.dispatch(env),
    viewerId: 'viewer-1',
    spaceId: SPACE,
    gate: { data, reasons: {}, serverBaseUrl: undefined, viewerMemberId: 'member-1', onNotice: () => {} },
  } as unknown as WorkspaceContextValue;
  runtime.dispatch({ command: 'workspace.drafts.open', args: { kind: 'loop' }, source: 'click' });
  const mount = () => render(
    <WorkspaceContext.Provider value={value}>
      <ContentHost />
    </WorkspaceContext.Provider>,
  );
  mount();
  const tab = Object.values(store.getState().tabs).find((t) => t.type === 'draft');
  if (!tab || tab.type !== 'draft') throw new Error('no draft tab opened');
  return { loops, store, tab, runtime, mount };
}

describe('New loop draft tab', () => {
  it('draws the loop form in the tab, not as a modal over the workspace', () => {
    openLoopDraft();
    expect(screen.getByTestId('tws-draft-loop')).toBeTruthy();
    expect(screen.getByTestId('loop-form')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.au-dialog__backdrop')).toBeNull();
  });

  it('keeps what was typed: a remount (tab switch, reload) restores the half-made loop', async () => {
    const { tab, runtime, mount } = openLoopDraft();
    expect(store_dirty(runtime, tab.id)).toBe(false);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning triage' } });
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    await waitFor(() => expect(runtime.drafts.get(tab.draftId)).toMatchObject({ v: 1, title: 'Morning triage', action: 'dispatch' }));
    expect(store_dirty(runtime, tab.id)).toBe(true);
    cleanup();
    mount();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Morning triage');
    expect(screen.getByTestId('loop-action-dispatch').getAttribute('aria-checked')).toBe('true');
  });

  it('a create binds the tab to the new loop', async () => {
    const { loops, store, tab } = openLoopDraft();
    const create = vi.spyOn(loops, 'create');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning triage' } });
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    fireEvent.click(screen.getByRole('button', { name: 'Create loop' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toBe(SPACE as SpaceId);
    const created = [...loops.loops.values()][0]!;
    await waitFor(() => expect(store.getState().tabs[tab.id]).toMatchObject({ type: 'entity', kind: 'loop', entityId: created.id }));
  });
});

function store_dirty(runtime: ReturnType<typeof createWorkspaceRuntime>, tabId: string): boolean {
  const tab = runtime.store.getState().tabs[tabId];
  return tab?.type === 'draft' ? Boolean(tab.dirty) : false;
}
