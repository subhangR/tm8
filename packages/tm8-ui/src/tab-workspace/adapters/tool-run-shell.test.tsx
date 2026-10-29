// @vitest-environment jsdom
/**
 * The tool page's Run WORKS in the real shell (Tools v2, lead decision
 * 2026-10-28): `ToolBody` enables Run only through a session opener, and no
 * host in `src/` ever mounted `ToolLaunchProvider` — only the e2e harness did —
 * so every human saw Run disabled with "A terminal host is unavailable in this
 * view". The tab workspace's entity body now provides it, opening the run's
 * session as its own tab exactly as a launched session opens.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityDetail } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../../fixtures';
import { createToolFixture, fixtureTool } from '../../tools/fixture';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { ContentHost } from '../view/ContentHost';
import { WorkspaceContext, type WorkspaceContextValue } from '../view/context';

const openTab = vi.fn();
vi.mock('../../tools/SourceEditor', () => ({ SourceEditor: ({ value }: { value: string }) => <textarea aria-label="Source" value={value} readOnly /> }));
vi.mock('../view/LinkedTrail', () => ({ LinkedTrail: () => null, useLinkedOpen: () => ({ openLinked: () => {}, openTab }) }));
vi.mock('../view/ChatDock', () => ({ ChatDock: () => null }));
vi.mock('../view/ActionStrip', () => ({ ActionStrip: () => null }));
vi.mock('../../views/useLaunchPort', () => ({ useLaunchPort: () => ({}) }));
vi.mock('../../views/usePanelPrimaries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../views/usePanelPrimaries')>()),
  usePanelPrimaries: () => ({ dialog: null, forEntity: () => undefined, wiredActions: [] }),
}));
vi.mock('../../views/useRowLifecycle', () => ({ useRowLifecycle: () => ({}) }));
vi.mock('../../views/membershipSurface', () => ({ useMembershipSurface: () => ({ authoringFor: () => null }) }));
vi.mock('../../views/useEntityVerbs', () => ({
  useEntityVerbs: () => ({ onAction: () => {}, wiredActions: [], edit: { open: false, state: { phase: 'idle' }, cancel: () => {} }, editFields: [], editTitle: '' }),
}));

beforeEach(() => openTab.mockReset());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const SPACE = fixtureTool.spaceId;
const toolDetail = {
  ...fixtureDetails[sessionStale.id]!,
  id: fixtureTool.id,
  kind: 'tool',
  spaceId: SPACE,
  title: fixtureTool.definition.name,
  version: fixtureTool.version,
  state: { kind: 'tool', name: fixtureTool.definition.name, runtime: 'bash', inputCount: 5, tm8Access: 'none' },
  content: { kind: 'tool', definition: fixtureTool.definition },
} as unknown as EntityDetail;

function openToolTab(fixture = createToolFixture()) {
  const store = createWorkspaceStore('viewer-1', SPACE);
  const runtime = createWorkspaceRuntime('viewer-1', SPACE, store);
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false, toast: vi.fn() });
  const data = {
    seam: { entity: async () => toolDetail, commands: { tools: fixture.port } },
    spaceId: SPACE,
    skillOptions: [],
    members: [],
    viewerActor: null,
    detailOf: (id: string) => (id === fixtureTool.id ? toolDetail : undefined),
    pull: vi.fn(),
    refetchDetail: vi.fn(),
    reconcileCommand: vi.fn(),
    livenessOf: () => 'unknown',
    capabilitiesOf: () => undefined,
    connectionsOf: () => undefined,
    messagesOf: () => [],
    linkedPullRequestsOf: () => [],
    rowsFor: () => () => [],
    spawn: vi.fn(),
    launch: { projects: [], teammates: [] },
    liveIds: new Set<string>(),
    postMessage: vi.fn(),
    ensureKind: vi.fn(),
    pageStateOf: () => () => undefined,
    loadMore: () => () => undefined,
  };
  const value = {
    runtime,
    store,
    dispatch: (env: never) => runtime.dispatch(env),
    viewerId: 'viewer-1',
    spaceId: SPACE,
    gate: { data, reasons: {}, serverBaseUrl: undefined, viewerMemberId: 'member-1', onNotice: () => {} },
  } as unknown as WorkspaceContextValue;
  runtime.dispatch({ command: 'workspace.tabs.open', args: { kind: 'tool', entityId: fixtureTool.id }, source: 'click' });
  render(
    <WorkspaceContext.Provider value={value}>
      <ContentHost />
    </WorkspaceContext.Provider>,
  );
  return { fixture, store };
}

describe('a tool tab in the Workspace', () => {
  it('enables Run, and running opens the run’s session as a work_session tab', async () => {
    const { fixture } = openToolTab();
    fixture.port.run = vi.fn(fixture.port.run);
    expect(screen.getByTestId('tws-entity-body').getAttribute('data-kind')).toBe('tool');
    const run = await screen.findByRole('button', { name: 'Run', exact: true });
    await waitFor(() => expect(run).toHaveProperty('disabled', false));
    expect(run.title).toBeFalsy();
    fireEvent.click(run);
    const dialog = await screen.findByRole('dialog', { name: `Run ${fixtureTool.definition.name}` });
    await waitFor(() => expect(screen.queryByText('Checking source changes…')).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));
    });
    await waitFor(() => expect(fixture.port.run).toHaveBeenCalled());
    await waitFor(() => expect(openTab).toHaveBeenCalledWith('work_session', expect.any(String)));
    const [, sessionId] = openTab.mock.calls[0] as [string, string];
    expect((await fixture.port.runGet(sessionId)).toolId).toBe(fixtureTool.id);
    expect(dialog).toBeTruthy();
  });

  it('a recorded run opens the same way from the run history', async () => {
    /* Recorded before the tab opens: the history loads once, when the page mounts. */
    const fixture = createToolFixture();
    const { sessionId } = await fixture.port.run({ toolId: fixtureTool.id, expectedVersion: fixtureTool.version, clientMutationId: 'seed-run', keepOpen: true, inputs: {} });
    fixture.finish(sessionId, 'exited', 0);
    openToolTab(fixture);
    await screen.findByRole('button', { name: 'Run', exact: true });
    const rows = await screen.findAllByRole('button', { name: /· v1$/ });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('disabled', false);
    fireEvent.click(rows[0]!);
    expect(openTab).toHaveBeenCalledWith('work_session', sessionId);
  });
});
