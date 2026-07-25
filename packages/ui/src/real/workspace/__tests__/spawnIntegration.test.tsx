/**
 * The acceptance seam: a task started inside the workspace must attach its new
 * session to the center pane without navigating away. SpawnDialog is shared,
 * so the Sessions-screen navigation path is asserted beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CollabFacade } from '../../../collab-v2/facade/CollabFacade';
import { useNavStore } from '../../../collab-v2/stores/nav';
import type { RealFacade } from '../../RealFacade';
import { SpawnDialog } from '../../SpawnDialog';
import { SESSION_SPAWNED_EVENT, SPAWN_REQUEST_EVENT } from '../../tm8Kinds';
import { WorkspaceScreen } from '../WorkspaceScreen';

vi.mock('../TaskPanel', () => ({
  TaskPanel: () => <div data-testid="task-panel" />,
}));

vi.mock('../CenterPane', () => ({
  CenterPane: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="center-session" data-session={sessionId ?? ''} />
  ),
}));

vi.mock('../ResourcePanel', () => ({
  ResourcePanel: ({ openSessionId }: { openSessionId: string | null }) => (
    <div data-testid="resource-session" data-session={openSessionId ?? ''} />
  ),
}));

const SPACE = 'spc_1';
const TASK = 'task_1';
const SESSION = 'session_new';

function fakeFacade() {
  return {
    listProjects: vi.fn(async () => ([{
      id: 'project_1', name: 'tm8', workingDir: '/tmp/tm8', trust: 'trusted',
    }])),
    queryCollection: vi.fn(async () => ({
      query: {},
      page: {
        items: [{ id: 'member_1', title: 'Echo agent' }],
        nextCursor: null,
      },
    })),
    spawnSession: vi.fn(async () => ({ entity: { id: SESSION } })),
  } as unknown as RealFacade;
}

function requestSpawn(): void {
  window.dispatchEvent(new CustomEvent(SPAWN_REQUEST_EVENT, {
    detail: { taskId: TASK, spaceId: SPACE },
  }));
}

async function submitSpawn(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Spawn' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Spawn' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

beforeEach(() => {
  useNavStore.getState().reset();
});

afterEach(() => {
  window.history.replaceState(null, '', '#/');
  useNavStore.getState().reset();
  vi.restoreAllMocks();
});

describe('SpawnDialog workspace handoff', () => {
  it('stays in the workspace and attaches the new session to its center pane', async () => {
    window.history.replaceState(null, '', `#/s/${SPACE}/workspace`);
    useNavStore.setState({ spaceId: SPACE, view: 'workspace', entityId: null });
    const facade = fakeFacade();
    const seen = vi.fn();
    window.addEventListener(SESSION_SPAWNED_EVENT, seen);

    render(
      <>
        <WorkspaceScreen
          facade={facade as unknown as CollabFacade}
          spaceId={SPACE}
          view="workspace"
          entityId={null}
          onOpenEntity={vi.fn()}
          onNavigate={vi.fn()}
        />
        <SpawnDialog facade={facade} />
      </>,
    );

    act(requestSpawn);
    await submitSpawn();

    expect(useNavStore.getState().view).toBe('workspace');
    expect(useNavStore.getState().entityId).toBeNull();
    expect(screen.getByTestId('center-session')).toHaveAttribute('data-session', SESSION);
    expect(screen.getByTestId('resource-session')).toHaveAttribute('data-session', SESSION);
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      sessionId: SESSION,
      taskId: TASK,
    });

    window.removeEventListener(SESSION_SPAWNED_EVENT, seen);
  });

  it('keeps the existing Sessions-screen navigation outside the workspace', async () => {
    window.history.replaceState(null, '', `#/s/${SPACE}/tasks`);
    useNavStore.setState({ spaceId: SPACE, view: 'tasks', entityId: null });
    const facade = fakeFacade();
    const seen = vi.fn();
    window.addEventListener(SESSION_SPAWNED_EVENT, seen);
    render(<SpawnDialog facade={facade} />);

    act(requestSpawn);
    await submitSpawn();

    expect(useNavStore.getState().view).toBe('sessions');
    expect(useNavStore.getState().entityId).toBe(SESSION);
    expect(seen).not.toHaveBeenCalled();

    window.removeEventListener(SESSION_SPAWNED_EVENT, seen);
  });
});
