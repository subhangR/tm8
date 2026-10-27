// @vitest-environment jsdom
/**
 * A session tab's loading frame wears the scope its loaded view will (task
 * 01a14c39). Subhang saw a dark title bar and side column around a WHITE
 * skeleton: the chrome knew the tab was a session, the skeleton did not. Now
 * the frame predicts the surface the session opens on — the terminal stays
 * black, the transcript follows the app theme like chat — and every piece
 * (title bar, body) agrees.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { ContentHost } from './ContentHost';
import { WorkspaceContext, type WorkspaceContextValue } from './context';

vi.mock('./LinkedTrail', () => ({ LinkedTrail: () => null, useLinkedOpen: () => ({ openLinked: () => {}, openTab: () => {} }) }));
vi.mock('./ChatDock', () => ({ ChatDock: () => null }));
vi.mock('./ActionStrip', () => ({ ActionStrip: () => null }));
vi.mock('../../views/useLaunchPort', () => ({ useLaunchPort: () => ({}) }));
vi.mock('../../views/usePanelPrimaries', () => ({ usePanelPrimaries: () => ({ dialog: null, forEntity: () => undefined }) }));
vi.mock('../../views/useRowLifecycle', () => ({ useRowLifecycle: () => ({}) }));
vi.mock('../../views/membershipSurface', () => ({ useMembershipSurface: () => ({}) }));
vi.mock('../../views/useEntityVerbs', () => ({
  useEntityVerbs: () => ({ onAction: () => {}, wiredActions: [], edit: null, editFields: [], editTitle: '' }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

function openWhileLoading(kind: string, entityId: string) {
  const store = createWorkspaceStore('viewer-1', 'space-1');
  const runtime = createWorkspaceRuntime('viewer-1', 'space-1', store);
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false });
  const data = {
    /* The read never answers: the tab stays on its loading frame. */
    seam: { entity: () => new Promise(() => {}) },
    spaceId: 'space-1',
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
    spaceId: 'space-1',
    gate: { data, reasons: {}, serverBaseUrl: undefined, viewerMemberId: 'member-1', onNotice: () => {} },
  } as unknown as WorkspaceContextValue;
  runtime.dispatch({ command: 'workspace.tabs.open', args: { kind, entityId }, source: 'click' });
  render(
    <WorkspaceContext.Provider value={value}>
      <ContentHost />
    </WorkspaceContext.Provider>,
  );
  act(() => {
    vi.advanceTimersByTime(250);
  });
  return { body: screen.getByTestId('tws-entity-body'), bar: screen.getByTestId('tws-titlebar') };
}

describe('a session tab loading', () => {
  it('opening on the terminal: the frame is the always-dark terminal stage, title bar included', () => {
    const { body, bar } = openWhileLoading('work_session', 'ws-1');
    expect(body.getAttribute('data-shape')).toBe('terminal');
    expect(body.classList.contains('cv2-root')).toBe(true);
    expect(body.getAttribute('data-theme')).toBe('dark');
    expect(bar.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByTestId('tws-state-loading').getAttribute('data-shape')).toBe('terminal');
  });

  it('opening on the transcript: the frame follows the app theme as a conversation, like chat', () => {
    window.localStorage.setItem('tm8:work-session-surface:v1:member-1:ws-2', 'transcript');
    const { body, bar } = openWhileLoading('work_session', 'ws-2');
    expect(body.getAttribute('data-shape')).toBe('chat');
    expect(body.classList.contains('cv2-root')).toBe(false);
    expect(body.getAttribute('data-theme')).toBeNull();
    expect(bar.getAttribute('data-theme')).toBeNull();
  });

  it('every other kind keeps the theme and the reading-measure lines', () => {
    const { body } = openWhileLoading('task', 'task-1');
    expect(body.getAttribute('data-shape')).toBe('document');
    expect(body.classList.contains('cv2-root')).toBe(false);
  });
});
