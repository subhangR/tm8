// @vitest-environment jsdom
/**
 * Entity chat, lane B (design 01a0da4e §3.2–3.3): the Chat verb beside Run,
 * its count, the dispatch that reopens the latest chat, and `EntityChatPanel`
 * with its switcher — driven through the slot host against the real store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DurableWorkspaceEvent, EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import { allKinds, getKind, resolveAction, type ActionContext } from '../domain';
import { ActionBar } from '../panels/detail/chrome';
import { navStore, resetNav } from '../stores/navStore';
import {
  EntityChatPanel,
  EntityChatSlot,
  chatsAboutFrom,
  eventTouchesChatsAbout,
  openEntityChat,
  switcherCaption,
  type ChatAboutRow,
} from './index';

vi.mock('../views/conversationSurface', () => ({
  entityChatSurfaceFor: (about: string, thread: string, _host: unknown, select: (t: string) => void) => (
    <div data-testid="stub-body" data-about={about} data-thread={thread}>
      <button type="button" onClick={() => select('01a0-created')}>stub-send</button>
    </div>
  ),
}));

const SPACE = 'sp-1';
const TASK = '01a0-task' as EntityId;
const ADA = '01a0-ada' as EntityId;

function chatSummary(id: string, title: string, lastTurnAt: string | null, extra: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id,
    spaceId: SPACE,
    kind: 'chat',
    title,
    createdAt: '2026-09-01T00:00:00Z',
    deletedAt: null,
    state: {
      kind: 'chat', teammateId: ADA, model: 'm', provider: 'p', agentTool: 't', mode: 'ask',
      workdirMode: 'scratch', projectId: null, runtimeState: 'cold', turnState: 'idle',
      turnCount: 1, lastTurnAt,
    },
    ...extra,
  } as unknown as EntitySummary;
}

function aboutEdge(source: EntitySummary, target: EntityId = TASK): EdgeView {
  return { id: `e-${source.id}`, type: 'about', source, target: { id: target } } as unknown as EdgeView;
}

const OLD = chatSummary('01a0-old', 'Older chat', '2026-09-10T00:00:00Z');
const NEW = chatSummary('01a0-new', 'Newest chat', '2026-09-20T00:00:00Z');
const MEMORY = { id: '01a0-mem', kind: 'memory', title: 'm', deletedAt: null, state: { kind: 'memory' } } as unknown as EntitySummary;

function fakeSeam(edges: EdgeView[]) {
  const listeners = new Set<(e: DurableWorkspaceEvent) => void>();
  return {
    connections: vi.fn(async () => ({ items: edges, nextCursor: null })),
    onEvent: (cb: (e: DurableWorkspaceEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (e: DurableWorkspaceEvent) => listeners.forEach((cb) => cb(e)),
    entity: vi.fn(async (id: string) => ({ id, title: 'Task A', kind: 'task' })),
  };
}

beforeEach(() => resetNav(SPACE));
afterEach(cleanup);

describe('the Chat verb beside Run (§3.2)', () => {
  it('is in every header right after Run — except message and chat — including work_session', () => {
    const checked: string[] = [];
    for (const row of allKinds()) {
      const primaries = row.panel.primaries ?? [];
      if (row.kind === 'message' || row.kind === 'chat') {
        expect(primaries, row.kind).not.toContain('chat-about');
        continue;
      }
      const run = primaries.indexOf('run');
      expect(primaries.indexOf('chat-about'), row.kind).toBe(run + 1);
      checked.push(row.kind);
    }
    expect(checked).toContain('work_session');
    expect(checked.length).toBeGreaterThan(10);
  });

  it('is labelled plain "Chat" with the ❝ glyph', () => {
    expect(resolveAction('chat-about').label).toBe('Chat');
    expect(resolveAction('chat-about').icon).toBe('❝');
  });

  it('draws `❝ Chat · N` in the detail header when the host measured a count', () => {
    const ctx = { spaceId: SPACE, entityId: TASK } as ActionContext;
    const onAction = vi.fn();
    render(
      <ActionBar
        config={getKind('task')}
        ctx={ctx}
        onAction={onAction}
        wiredActions={['chat-about']}
        primaryCounts={{ 'chat-about': 3 }}
      />,
    );
    const button = screen.getByTestId('panel-primary-chat-about');
    expect(button.textContent).toBe('❝ Chat· 3');
    expect(screen.getByTestId('panel-primary-count-chat-about').textContent).toContain('3');
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith('chat-about');
  });

  it('draws no number at zero, and plain "Chat" before the count is known', () => {
    const ctx = { spaceId: SPACE, entityId: TASK } as ActionContext;
    const { rerender } = render(
      <ActionBar config={getKind('task')} ctx={ctx} onAction={() => {}} wiredActions={['chat-about']} primaryCounts={{ 'chat-about': 0 }} />,
    );
    expect(screen.queryByTestId('panel-primary-count-chat-about')).toBeNull();
    rerender(<ActionBar config={getKind('task')} ctx={ctx} onAction={() => {}} wiredActions={['chat-about']} />);
    expect(screen.getByTestId('panel-primary-chat-about').textContent).toBe('Chat');
  });
});

describe('the chats about an entity', () => {
  it('keeps chats only, newest first, and drops deleted ones', () => {
    const gone = chatSummary('01a0-gone', 'Gone', '2026-09-25T00:00:00Z', { deletedAt: '2026-09-26T00:00:00Z' });
    const rows = chatsAboutFrom([aboutEdge(OLD), aboutEdge(MEMORY), aboutEdge(NEW), aboutEdge(gone)]);
    expect(rows.map((row) => row.id)).toEqual(['01a0-new', '01a0-old']);
    expect(rows[0]).toMatchObject({ title: 'Newest chat', teammateId: ADA });
  });

  it('refreshes on an about edge naming the subject, or a change to a listed chat — nothing else', () => {
    const known = new Set<EntityId>(['01a0-old' as EntityId]);
    const edge = (type: string, target: string) =>
      ({ type: 'edge.upsert', edge: { type, target: { id: target } } }) as unknown as DurableWorkspaceEvent;
    expect(eventTouchesChatsAbout(edge('about', TASK), TASK, known)).toBe(true);
    expect(eventTouchesChatsAbout(edge('about', 'other'), TASK, known)).toBe(false);
    expect(eventTouchesChatsAbout(edge('relates_to', TASK), TASK, known)).toBe(false);
    const upsert = (id: string) => ({ type: 'entity.upsert', entity: { id } }) as unknown as DurableWorkspaceEvent;
    expect(eventTouchesChatsAbout(upsert('01a0-old'), TASK, known)).toBe(true);
    expect(eventTouchesChatsAbout(upsert('01a0-unrelated'), TASK, known)).toBe(false);
  });
});

describe('the dispatch (Q1)', () => {
  it('reopens the most recent chat about the entity — a history push', async () => {
    const seam = fakeSeam([aboutEdge(OLD), aboutEdge(NEW)]);
    await openEntityChat(seam as never, TASK);
    expect(navStore.getState().chat).toEqual({ about: TASK, thread: '01a0-new' });
    expect(navStore.getState().history).toBe('push');
  });

  it('opens the composer when the entity has no chats', async () => {
    await openEntityChat(fakeSeam([aboutEdge(MEMORY)]) as never, TASK);
    expect(navStore.getState().chat).toEqual({ about: TASK, thread: 'new' });
  });
});

describe('EntityChatPanel (§3.3)', () => {
  const rows: ChatAboutRow[] = chatsAboutFrom([aboutEdge(NEW), aboutEdge(OLD)]);

  it('captions the switcher `Chat N of M`, `New chat`, or a bare `Chat` while the list catches up', () => {
    expect(switcherCaption('01a0-old' as EntityId, rows)).toBe('Chat 2 of 2');
    expect(switcherCaption('new', rows)).toBe('New chat');
    expect(switcherCaption('01a0-just-made' as EntityId, rows)).toBe('Chat');
    expect(switcherCaption('01a0-old' as EntityId, null)).toBe('Chat');
  });

  it('header: subject chip, switcher newest first with teammate, + New, close', () => {
    const onOpenSubject = vi.fn();
    const onSelectThread = vi.fn();
    const onClose = vi.fn();
    render(
      <EntityChatPanel
        slot={{ about: TASK, thread: '01a0-old' as EntityId }}
        subject={{ id: TASK, title: 'Task A', glyph: '▢' }}
        chats={rows}
        teammateLabel={(id) => (id === ADA ? 'Ada' : null)}
        onOpenSubject={onOpenSubject}
        onSelectThread={onSelectThread}
        onClose={onClose}
      >
        <p>body</p>
      </EntityChatPanel>,
    );
    const chip = screen.getByTestId('entity-chat-subject');
    expect(chip.textContent).toBe('about ▢ Task A');
    fireEvent.click(chip);
    expect(onOpenSubject).toHaveBeenCalledWith(TASK);

    fireEvent.click(screen.getByTestId('entity-chat-switcher'));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Newest chat'),
      expect.stringContaining('Older chat'),
    ]);
    expect(items[0]!.textContent).toContain('Ada');
    expect(items[1]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(items[0]!);
    expect(onSelectThread).toHaveBeenCalledWith('01a0-new');

    fireEvent.click(screen.getByTestId('entity-chat-new'));
    expect(onSelectThread).toHaveBeenLastCalledWith('new');
    fireEvent.click(screen.getByTestId('entity-chat-close'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('EntityChatSlot — the host the layouts place', () => {
  const host = (seam: ReturnType<typeof fakeSeam>) => ({
    seam: seam as never,
    spaceId: SPACE,
    nodeKey: 'local',
    onOpenEntity: () => {},
  });

  it('renders nothing while no slot is open', () => {
    const { container } = render(<EntityChatSlot {...host(fakeSeam([]))} />);
    expect(container.innerHTML).toBe('');
  });

  it('switching REPLACES the thread in the route; new→created is the same move', async () => {
    const seam = fakeSeam([aboutEdge(OLD), aboutEdge(NEW)]);
    act(() => navStore.getState().openChat({ about: TASK, thread: 'new' }));
    /* A pass-through gate: this test is about the route, not the card (lane C). */
    render(<EntityChatSlot {...host(seam)} newChatGate={(composerFor) => composerFor()} subjectOf={() => ({ title: 'Task A', kind: 'task' })} />);
    expect(screen.getByTestId('stub-body').dataset.thread).toBe('new');
    await waitFor(() => expect(screen.getByTestId('entity-chat-switcher').hasAttribute('disabled')).toBe(false));

    fireEvent.click(screen.getByTestId('entity-chat-switcher'));
    fireEvent.click(screen.getByTestId('entity-chat-item-01a0-old'));
    expect(navStore.getState().chat).toEqual({ about: TASK, thread: '01a0-old' });
    expect(navStore.getState().history).toBe('replace');
    expect(screen.getByTestId('stub-body').dataset.thread).toBe('01a0-old');
    expect(screen.getByTestId('entity-chat-switcher').textContent).toContain('Chat 2 of 2');

    fireEvent.click(screen.getByTestId('entity-chat-new'));
    fireEvent.click(screen.getByText('stub-send'));
    expect(navStore.getState().chat).toEqual({ about: TASK, thread: '01a0-created' });
    expect(navStore.getState().history).toBe('replace');

    fireEvent.click(screen.getByTestId('entity-chat-close'));
    expect(navStore.getState().chat).toBeNull();
  });

  it('hands the composer to lane C’s gate only while the thread is new', () => {
    act(() => navStore.getState().openChat({ about: TASK, thread: 'new' }));
    const gate = vi.fn((composerFor: () => React.ReactNode) => <div data-testid="gate">{composerFor()}</div>);
    render(<EntityChatSlot {...host(fakeSeam([]))} newChatGate={gate} subjectOf={() => ({ title: 'T', kind: 'task' })} />);
    expect(screen.getByTestId('gate')).toBeTruthy();
    expect(gate).toHaveBeenCalledWith(expect.anything(), { id: TASK, kind: 'task' });
    act(() => navStore.getState().setChatThread('01a0-old' as EntityId));
    expect(screen.queryByTestId('gate')).toBeNull();
  });

  it('re-reads the switcher when an about edge names the subject', async () => {
    const edges = [aboutEdge(OLD)];
    const seam = fakeSeam(edges);
    act(() => navStore.getState().openChat({ about: TASK, thread: '01a0-old' as EntityId }));
    render(<EntityChatSlot {...host(seam)} />);
    await waitFor(() => expect(screen.getByTestId('entity-chat-switcher').textContent).toContain('Chat 1 of 1'));
    edges.push(aboutEdge(NEW));
    act(() => seam.emit({ type: 'edge.upsert', edge: aboutEdge(NEW) } as unknown as DurableWorkspaceEvent));
    await waitFor(() => expect(screen.getByTestId('entity-chat-switcher').textContent).toContain('Chat 2 of 2'));
    // The subject chip fell back to one entity read.
    await waitFor(() => expect(screen.getByTestId('entity-chat-subject').textContent).toContain('Task A'));
  });
});
