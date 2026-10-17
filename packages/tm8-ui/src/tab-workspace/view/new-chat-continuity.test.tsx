// @vitest-environment jsdom
/**
 * A new chat continues in place after its first Send (task 01a14a83).
 *
 * The draft tab's Send creates the chat and `drafts.bind` turns the tab into
 * the chat's entity tab. That used to swap `DraftHost` for `EntityTab` and
 * remount the chat screen, which then stepped through the entity skeleton,
 * "Loading Chat…" and "Reading this conversation…". The screen that sent the
 * message must be the screen that shows the answer: mounted once, and none of
 * those loading states on screen in between.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { ContentHost } from './ContentHost';
import { WorkspaceContext, type WorkspaceContextValue } from './context';

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

/* The chat screen: a counter of its own mounts, a Send that "creates" the
   chat, and a turn that keeps streaming in its own state. */
vi.mock('../../chat-home/ChatHomeSurface', () => ({
  ChatHomeSurface: (props: { onThreadSelected?: (id: string | null) => void; routeThreadId?: string | null }) => {
    const [turn, setTurn] = useState<string[]>([]);
    useEffect(() => {
      lifecycle.mounts += 1;
      return () => {
        lifecycle.unmounts += 1;
      };
    }, []);
    return (
      <div data-testid="fake-chat" data-route={props.routeThreadId ?? ''}>
        <textarea data-testid="fake-composer" />
        <button
          type="button"
          data-testid="fake-send"
          onClick={() => {
            setTurn(['you: hello']);
            props.onThreadSelected?.('chat-1');
          }}
        >
          Send
        </button>
        <button type="button" data-testid="fake-stream" onClick={() => setTurn((t) => [...t, 'agent: hi'])}>
          stream
        </button>
        <ol data-testid="fake-turn">{turn.map((line) => <li key={line}>{line}</li>)}</ol>
      </div>
    );
  },
}));

/* The entity tab's chrome around the body is not what this test is about. */
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
vi.mock('../../authoring', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  EditEntityDialog: () => null,
}));
/* The panel: a chat's body is its conversation slot, composed by the real
   `conversationSurfaceFor` — the composition every host shares. */
vi.mock('../../views/auxPanel', async () => {
  const { conversationSurfaceFor } = await import('../../views/conversationSurface');
  return {
    AuxEntityPanel: ({ host, entityId, onOpenEntity }: { host: { data: { detailOf(id: string): EntityDetail | undefined } }; entityId: EntityId; onOpenEntity(id: EntityId): void }) => (
      <div className="pn-conversation-body" data-testid="fake-panel">
        {conversationSurfaceFor(host.data.detailOf(entityId), entityId, {
          seam: {} as never,
          spaceId: 'space-1',
          connection: 'open' as never,
          livenessOf: () => 'unknown' as never,
          channelFeedPort: {} as never,
          nodeKey: 'local',
          onOpenEntity,
          onSwitchToTerminal: () => {},
        })}
      </div>
    ),
  };
});

afterEach(() => {
  cleanup();
  lifecycle.mounts = 0;
  lifecycle.unmounts = 0;
});

const chatDetail = { id: 'chat-1', kind: 'chat', title: 'hello', version: 1, state: {}, content: {}, capabilities: {} } as unknown as EntityDetail;

function mount() {
  const store = createWorkspaceStore('viewer-1', 'space-1');
  const runtime = createWorkspaceRuntime('viewer-1', 'space-1', store);
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false });
  const details = new Map<string, EntityDetail>();
  const listeners = new Set<() => void>();
  const data = {
    seam: { entity: () => new Promise(() => {}) },
    spaceId: 'space-1',
    skillOptions: [],
    detailOf: (id: string) => details.get(id),
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
    gate: { data, reasons: {}, serverBaseUrl: undefined, viewerMemberId: 'viewer-1', onNotice: () => {} },
  } as unknown as WorkspaceContextValue;
  runtime.dispatch({ command: 'workspace.drafts.open', args: { kind: 'chat' }, source: 'click' });
  const view = render(
    <WorkspaceContext.Provider value={value}>
      <ContentHost />
    </WorkspaceContext.Provider>,
  );
  /* The gate's detail arriving: a re-render of the host, as a store write would. */
  const arrive = (detail: EntityDetail) => {
    details.set(detail.id, detail);
    listeners.forEach((l) => l());
    view.rerender(
      <WorkspaceContext.Provider value={{ ...value }}>
        <ContentHost />
      </WorkspaceContext.Provider>,
    );
  };
  return { runtime, store, arrive };
}

const LOADING = ['tws-state-loading', 'tws-state-slow', 'chat-detail-loading'];

function expectNoLoading() {
  for (const id of LOADING) expect(screen.queryByTestId(id)).toBeNull();
  expect(screen.queryByText('Loading Chat…')).toBeNull();
}

describe('a new chat continues in place after its first Send', () => {
  it('keeps the one chat screen from Send through the bind to the first streamed answer', () => {
    const { store, arrive } = mount();
    expect(screen.getByTestId('tws-draft-chat')).toBeTruthy();
    expect(lifecycle.mounts).toBe(1);
    // The composer is the chat's own create door: no draft Cancel bar under it.
    expect(screen.queryByTestId('tws-draft-cancel')).toBeNull();
    const composer = screen.getByTestId('fake-composer');
    composer.focus();

    act(() => {
      fireEvent.click(screen.getByTestId('fake-send'));
    });
    const tab = Object.values(store.getState().tabs)[0]!;
    expect(tab.type).toBe('entity');
    // The tab bound while its detail is still unread: the screen stays, no skeleton.
    expect(screen.queryByTestId('tws-draft-chat')).toBeNull();
    expectNoLoading();
    expect(screen.getByTestId('fake-turn').textContent).toBe('you: hello');
    expect(document.activeElement).toBe(composer);

    // The detail lands and the chat panel's conversation slot takes the same screen.
    act(() => arrive(chatDetail));
    expect(screen.getByTestId('fake-panel').contains(screen.getByTestId('fake-chat'))).toBe(true);
    expectNoLoading();
    // …under no empty title row: the tab's label names the chat.
    expect(screen.queryByTestId('tws-titlebar')).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId('fake-stream'));
    });
    expect(screen.getByTestId('fake-turn').textContent).toBe('you: helloagent: hi');
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('lets go of the kept screen when its tab is left, so a revisit mounts the ordinary chat', async () => {
    const { runtime, store, arrive } = mount();
    act(() => {
      fireEvent.click(screen.getByTestId('fake-send'));
    });
    act(() => arrive(chatDetail));
    const chatTab = Object.values(store.getState().tabs)[0]!.id;

    act(() => {
      runtime.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'task-1' }, source: 'click' });
    });
    expect(lifecycle.unmounts).toBe(1);
    expect(screen.queryByTestId('kept-chat-surface')).toBeNull();

    act(() => {
      runtime.dispatch({ command: 'workspace.tabs.activate', args: { tabId: chatTab }, source: 'click' });
    });
    // The ordinary entity mount: its own screen, pinned to the chat by route.
    const chat = await screen.findByTestId('fake-chat');
    expect(chat.getAttribute('data-route')).toBe('chat-1');
    expect(lifecycle.mounts).toBe(2);
  });
});
