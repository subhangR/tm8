// @vitest-environment jsdom
/**
 * Task 01a14a91: the strip rolls up what a chat's child sessions made, and a
 * human (or agent) tags any entity to the chat with one `attached_to` edge.
 */
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId, EntitySummary } from '@tm8/contract';
import { CreatedHereStrip } from './CreatedHereStrip';
import { fakeCreatedHereReader, madeSummary } from './created-here.test-support';
import type { ChatTag } from './reader';

const CHAT = '019f0000-0000-7000-8000-00000000c0c0' as EntityId;
const SPACE = '019f0000-0000-7000-8000-000000000090';
const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function memoryStorage(initial?: Record<string, unknown>): Storage {
  const map = new Map<string, string>();
  if (initial) map.set(`tm8.chat.createdHere.${CHAT}`, JSON.stringify(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() { return map.size; },
  };
}

const session = (n: number) => madeSummary({ id: id(n), kind: 'work_session', parentId: CHAT, title: `Session ${n}` });
const doc = (n: number) => madeSummary({ id: id(n), kind: 'doc', title: `Doc ${n}` });
const task = (n: number) => madeSummary({ id: id(n), kind: 'task', title: `Task ${n}` });
const turns = [{ messageId: id(90), role: 'user', author: null, createdAt: '2026-10-17T10:00:00.000Z', body: 'hi', parts: [] }] as never;

function edgeEvent(type: 'edge.upsert' | 'edge.deleted', edgeType: string, edgeId: string, source: EntitySummary, targetId: string) {
  return {
    type, spaceId: SPACE, seq: 1, occurredAt: '', schemaVersion: 1,
    edge: {
      id: edgeId, type: edgeType, source, target: madeSummary({ id: targetId, kind: 'chat' }), props: {},
      createdBy: source.createdBy, createdAt: '', updatedAt: '',
    },
  } as never;
}

describe('CreatedHereStrip rollup and tags', () => {
  it('shows a doc a child session made, says which session, and hangs it under that session', async () => {
    const reader = fakeCreatedHereReader({
      // The server's createdIn rolls the session's doc up as a root.
      roots: [session(1), doc(2)],
      outputs: { [id(1)]: [doc(2)] },
    });
    const view = render(
      <CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={memoryStorage({ expanded: true, kind: 'doc' })} />,
    );
    const row = await view.findByTestId('created-here-row');
    expect(within(row).getByText('Doc 2')).toBeTruthy();
    await waitFor(() => expect(within(row).getByText('from Session 1')).toBeTruthy());

    fireEvent.click(view.getAllByTestId('created-here-kind').find((c) => c.getAttribute('data-kind') === 'work_session')!);
    const body = await view.findByTestId('created-here-body');
    const twisty = await within(body).findByRole('button', { name: /Expand Session 1/ });
    fireEvent.click(twisty);
    await waitFor(() => expect(within(body).getByText('Doc 2')).toBeTruthy());
  });

  it('attaches an entity from search, keeps it across a remount, and removes it', async () => {
    const reader = fakeCreatedHereReader({ roots: [session(1)], searchable: [task(7)] });
    const storage = memoryStorage();
    const view = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={storage} />);
    fireEvent.click(await view.findByTestId('created-here-attach'));
    fireEvent.change(view.getByLabelText('Find an entity to attach to this chat'), { target: { value: 'task' } });
    const pick = await view.findByTestId('created-here-attach-result');
    await act(async () => {
      fireEvent.click(pick);
    });
    expect(reader.calls.tag).toEqual([id(7)]);
    expect(view.queryByTestId('created-here-attach-panel')).toBeNull();
    // It opened the tagged entity's kind.
    const body = await view.findByTestId('created-here-body');
    expect(within(body).getByText('Task 7')).toBeTruthy();
    expect(within(body).getByTestId('created-here-tagged')).toBeTruthy();

    view.unmount();
    const again = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={storage} />);
    const kept = await again.findByTestId('created-here-body');
    await waitFor(() => expect(within(kept).getByText('Task 7')).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(kept).getByRole('button', { name: 'Remove Task 7 from this chat' }));
    });
    expect(reader.calls.untag).toEqual([`edge-${id(7)}`]);
    await waitFor(() => expect(again.queryByText('Task 7')).toBeNull());
  });

  it('says why an attach was refused and keeps the picker open', async () => {
    const reader = fakeCreatedHereReader({ roots: [session(1)], searchable: [task(7)], refuseTag: 'kind not allowed' });
    const view = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={memoryStorage()} />);
    fireEvent.click(await view.findByTestId('created-here-attach'));
    fireEvent.change(view.getByLabelText('Find an entity to attach to this chat'), { target: { value: 'x' } });
    const pick = await view.findByTestId('created-here-attach-result');
    await act(async () => {
      fireEvent.click(pick);
    });
    expect((await view.findByRole('alert')).textContent).toBe('Not attached: kind not allowed');
    expect(view.getByTestId('created-here-attach-panel')).toBeTruthy();
  });

  it('offers + on a chat that made nothing yet, once it has turns', async () => {
    const reader = fakeCreatedHereReader({});
    const view = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={memoryStorage()} turns={turns} />);
    expect(await view.findByTestId('created-here-attach')).toBeTruthy();
    expect(view.queryByTestId('created-here-toggle')).toBeNull();
  });

  it('draws a tag and drops it live from the edge events', async () => {
    const tags: ChatTag[] = [];
    const reader = fakeCreatedHereReader({ roots: [session(1)], tags });
    const view = render(
      <CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={memoryStorage({ expanded: true, kind: 'task' })} />,
    );
    await view.findByTestId('created-here');
    act(() => reader.emit(edgeEvent('edge.upsert', 'attached_to', 'e-1', task(8), CHAT)));
    expect(await view.findByText('Task 8')).toBeTruthy();
    // A tag on some other chat is not this one's.
    act(() => reader.emit(edgeEvent('edge.upsert', 'attached_to', 'e-2', task(9), id(99))));
    expect(view.queryByText('Task 9')).toBeNull();
    act(() => reader.emit(edgeEvent('edge.deleted', 'attached_to', 'e-1', task(8), CHAT)));
    await waitFor(() => expect(view.queryByText('Task 8')).toBeNull());
  });

  it('picks up a child session’s new output live', async () => {
    const roots: EntitySummary[] = [session(1)];
    const outputs: Record<string, EntitySummary[]> = { [id(1)]: [] };
    const reader = fakeCreatedHereReader({ roots, outputs });
    const view = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={memoryStorage()} />);
    await view.findByTestId('created-here');
    const before = reader.calls.roots;
    // The server now rolls the doc up; the edge event is the cue to re-ask.
    roots.push(doc(3));
    act(() => reader.emit(edgeEvent('edge.upsert', 'authored_from', 'e-3', doc(3), id(1))));
    await waitFor(() => expect(reader.calls.roots).toBeGreaterThan(before), { timeout: 2000 });
    await waitFor(() =>
      expect(view.getAllByTestId('created-here-kind').map((c) => c.getAttribute('data-kind'))).toEqual(['work_session', 'doc']),
    );
  });
});
