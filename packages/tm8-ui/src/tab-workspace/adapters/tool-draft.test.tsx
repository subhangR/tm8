// @vitest-environment jsdom
/**
 * New tool in the Workspace (Tools v2 §3.1): the draft tab hosts the
 * tool-definition door, the create binds the tab to the new tool (it opens in
 * the centre), a refusal keeps the draft with the server's words, and the
 * half-written form is stored so a remount restores it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolFixture, HEADER_NOT_STORED } from '../../tools/fixture';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { ContentHost } from '../view/ContentHost';
import { WorkspaceContext, type WorkspaceContextValue } from '../view/context';

vi.mock('../../tools/SourceEditor', () => ({ SourceEditor: ({ value, onChange, readOnly }: { value: string; onChange(value: string): void; readOnly?: boolean }) => <textarea aria-label="Source" value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} /> }));
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

function openToolDraft(options: { headerStored?: boolean } = {}) {
  const fixture = createToolFixture(undefined, {}, options);
  const store = createWorkspaceStore('viewer-1', SPACE);
  const runtime = createWorkspaceRuntime('viewer-1', SPACE, store);
  const toast = vi.fn();
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false, toast });
  const data = {
    /* The created tool's detail never answers here: the bound tab stays on its loading frame. */
    seam: { entity: () => new Promise(() => {}), commands: { tools: fixture.port } },
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
  runtime.dispatch({ command: 'workspace.drafts.open', args: { kind: 'tool' }, source: 'click' });
  render(
    <WorkspaceContext.Provider value={value}>
      <ContentHost />
    </WorkspaceContext.Provider>,
  );
  const tab = Object.values(store.getState().tabs).find((t) => t.type === 'draft');
  if (!tab || tab.type !== 'draft') throw new Error('no draft tab opened');
  return { fixture, store, runtime, toast, tab };
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const fill = (name: string) => {
  fireEvent.change(field('Name'), { target: { value: name } });
  fireEvent.change(field('Description'), { target: { value: 'Made in the New tab' } });
};

describe('New tool draft tab', () => {
  it('hosts the tool-definition form under its heading, and the create binds the tab to the new tool', async () => {
    const { fixture, store, tab } = openToolDraft();
    expect(screen.getByTestId('tws-draft-tool')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'New tool' })).toBeTruthy();
    expect(screen.getByLabelText('Start from a starter')).toBeTruthy();
    fill('made-here');
    fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));
    await waitFor(() => expect(fixture.created).toHaveLength(1));
    const created = fixture.created[0]!;
    expect(created.definition.name).toBe('made-here');
    await waitFor(() => {
      const bound = store.getState().tabs[tab.id];
      expect(bound).toMatchObject({ type: 'entity', kind: 'tool', entityId: created.id });
    });
    // The tool's tab is on screen (its detail is still loading in this harness).
    expect(screen.getByTestId('tws-entity-body').getAttribute('data-kind')).toBe('tool');
  });

  it('a refusal keeps the draft, in the server’s words, and nothing binds', async () => {
    const { fixture, store, tab } = openToolDraft();
    fill('url-check'); // the fixture already holds url-check
    fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));
    expect(await screen.findByText('a live tool already has this name')).toBeTruthy();
    expect(fixture.created).toHaveLength(0);
    expect(store.getState().tabs[tab.id]?.type).toBe('draft');
    expect(screen.getByRole('button', { name: 'Create tool' })).toHaveProperty('disabled', false);
  });

  it('a selection header the node did not store is a toast on a created tool', async () => {
    const { fixture, toast } = openToolDraft({ headerStored: false });
    fill('header-skipped');
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: 'Open when greeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));
    await waitFor(() => expect(fixture.created).toHaveLength(1));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ text: expect.stringContaining(HEADER_NOT_STORED) }));
  });

  it('stores the form as typed, so a remount restores it', async () => {
    const { runtime, tab } = openToolDraft();
    fireEvent.change(screen.getByLabelText('Start from a starter'), { target: { value: 'space-digest' } });
    fireEvent.change(field('Name'), { target: { value: 'digest-copy' } });
    await waitFor(() => expect(runtime.drafts.get(tab.draftId)).toMatchObject({ starter: 'space-digest', draft: { name: 'digest-copy', runtime: 'python' } }));
    await act(async () => {
      cleanup();
    });
    const store = runtime.store;
    const value = {
      runtime, store, dispatch: (env: never) => runtime.dispatch(env), viewerId: 'viewer-1', spaceId: SPACE,
      gate: { data: { seam: { entity: () => new Promise(() => {}), commands: { tools: createToolFixture().port } }, spaceId: SPACE, skillOptions: [], detailOf: () => undefined, pull: vi.fn(), refetchDetail: vi.fn(), livenessOf: () => 'unknown' }, reasons: {}, serverBaseUrl: undefined, viewerMemberId: 'member-1', onNotice: () => {} },
    } as unknown as WorkspaceContextValue;
    render(
      <WorkspaceContext.Provider value={value}>
        <ContentHost />
      </WorkspaceContext.Provider>,
    );
    expect(field('Name').value).toBe('digest-copy');
    expect((screen.getByLabelText('Start from a starter') as HTMLSelectElement).value).toBe('space-digest');
  });
});
