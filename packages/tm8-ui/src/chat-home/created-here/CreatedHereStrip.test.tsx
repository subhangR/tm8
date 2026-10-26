// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { CreatedHereStrip } from './CreatedHereStrip';
import { fakeCreatedHereReader, madeSummary } from './created-here.test-support';

const CHAT = '019f0000-0000-7000-8000-00000000c0c0' as EntityId;
const SPACE = '019f0000-0000-7000-8000-000000000090';
const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() { return map.size; },
  };
}

const session = (n: number, extra: Record<string, unknown> = {}) =>
  madeSummary({
    id: id(n), kind: 'work_session', parentId: CHAT, title: `Session ${n}`,
    state: { kind: 'work_session', status: 'running', agentTool: 'claude-code', model: 'claude-opus-5', shareMode: 'space', startedAt: null, exitedAt: null, teammate: { displayName: 'Worker' }, ...extra } as never,
  });
const task = (n: number, parentId: string | null = null) =>
  madeSummary({ id: id(n), kind: 'task', parentId, title: `Task ${n}` });

describe('CreatedHereStrip', () => {
  it('renders nothing when the chat created nothing', async () => {
    const reader = fakeCreatedHereReader({});
    const view = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={memoryStorage()} />);
    await waitFor(() => expect(reader.calls.roots).toBe(1));
    expect(view.queryByTestId('created-here')).toBeNull();
  });

  it('shows one icon+count chip per created kind, and a live summary, collapsed by default', async () => {
    const reader = fakeCreatedHereReader({ roots: [session(1), session(2), task(3)] });
    const view = render(
      <CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={memoryStorage()} livenessOf={() => 'live'} />,
    );
    await waitFor(() => expect(view.getAllByTestId('created-here-kind')).toHaveLength(2));
    const chips = view.getAllByTestId('created-here-kind');
    expect(chips.map((c) => [c.getAttribute('data-kind'), c.textContent])).toEqual([['work_session', '2'], ['task', '1']]);
    expect(chips[0]!.getAttribute('aria-selected')).toBe('true');
    expect(view.getByTestId('created-here-summary').textContent).toContain('2 running');
    expect(view.queryByTestId('created-here-body')).toBeNull();
  });

  it('expands to the selected kind’s roots, lazily opens children, and remembers per chat', async () => {
    const storage = memoryStorage();
    const reader = fakeCreatedHereReader({
      roots: [session(1), task(3)],
      children: { [id(3)]: [task(4, id(3))], [id(4)]: [task(5, id(4))] },
    });
    const opened: string[] = [];
    const view = render(
      <CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={storage} onOpenEntity={(e) => opened.push(e)} />,
    );
    await waitFor(() => expect(view.getAllByTestId('created-here-kind')).toHaveLength(2));
    fireEvent.click(view.getAllByTestId('created-here-kind')[1]!);
    const body = await view.findByTestId('created-here-body');
    await waitFor(() => expect(within(body).getAllByTestId('created-here-row')).toHaveLength(1));
    expect(within(body).getByText('Task 3')).toBeTruthy();

    // ⌥-click opens the whole subtree.
    const twisty = await within(body).findByRole('button', { name: /Expand Task 3/ });
    await act(async () => {
      fireEvent.click(twisty, { altKey: true });
    });
    await waitFor(() => expect(within(body).getByText('Task 5')).toBeTruthy());

    fireEvent.click(within(body).getByText('Task 4'));
    expect(opened).toEqual([id(4)]);

    expect(JSON.parse(storage.getItem(`tm8.chat.createdHere.${CHAT}`)!)).toEqual({ expanded: true, kind: 'task' });
    view.unmount();
    const again = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={storage} />);
    await again.findByTestId('created-here-body');
    expect(again.getAllByTestId('created-here-kind')[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('offers Stop, Peek and Message on a live session row', async () => {
    const storage = memoryStorage();
    storage.setItem(`tm8.chat.createdHere.${CHAT}`, JSON.stringify({ expanded: true, kind: 'work_session' }));
    const reader = fakeCreatedHereReader({ roots: [session(1)] });
    const view = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={storage} livenessOf={() => 'live'} />);
    const row = await view.findByTestId('created-here-row');
    expect(within(row).getByText('Worker · claude-opus-5')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Peek' }));
    expect(await view.findByText('Running the focused tests now.')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Message' }));
    const input = view.getByLabelText('Message Session 1');
    fireEvent.change(input, { target: { value: 'status?' } });
    await act(async () => {
      fireEvent.submit(input.closest('form')!);
    });
    expect(reader.calls.message).toEqual([[id(1), 'status?']]);

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Stop' }));
    });
    expect(reader.calls.stop).toEqual([id(1)]);
  });

  it('greys a finished session and drops its write verbs', async () => {
    const storage = memoryStorage();
    storage.setItem(`tm8.chat.createdHere.${CHAT}`, JSON.stringify({ expanded: true, kind: 'work_session' }));
    const reader = fakeCreatedHereReader({ roots: [session(1, { status: 'exited', outcome: 'completed' })] });
    const view = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={storage} livenessOf={() => 'not-running'} />);
    const row = await view.findByTestId('created-here-row');
    expect(row.querySelector('.tch-made__row')!.hasAttribute('data-closed')).toBe(true);
    expect(within(row).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Message' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Peek' })).toBeTruthy();
  });

  it('adds what the transcript created when the server recorded nothing', async () => {
    const turns = [{
      messageId: id(50) as EntityId, role: 'assistant' as const, author: null, createdAt: '2026-10-17T10:00:00.000Z', body: '',
      parts: [
        { kind: 'tool_call' as const, seq: 0, toolCallId: 'tc', name: 'mcp__tm8__tm8_act',
          args: { operation: 'entities.create', body: { kind: 'task', title: 'From the transcript' } }, state: 'completed' as const },
        { kind: 'tool_result' as const, seq: 1, toolCallId: 'tc', content: { entity: { id: id(60), kind: 'task', title: 'From the transcript' } } },
      ],
    }];
    const reader = fakeCreatedHereReader({ reads: [madeSummary({ id: id(60), kind: 'task', title: 'From the transcript' })] });
    const view = render(
      <CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={memoryStorage()} turns={turns as never} />,
    );
    await waitFor(() => expect(view.getAllByTestId('created-here-kind')).toHaveLength(1));
    expect(view.getByTestId('created-here-kind').getAttribute('data-kind')).toBe('task');
  });

  it('updates a row from the event stream', async () => {
    const storage = memoryStorage();
    storage.setItem(`tm8.chat.createdHere.${CHAT}`, JSON.stringify({ expanded: true, kind: 'task' }));
    const reader = fakeCreatedHereReader({ roots: [task(3)] });
    const view = render(<CreatedHereStrip chatId={CHAT} spaceId={SPACE} reader={reader} storage={storage} />);
    await view.findByText('Task 3');
    act(() => {
      reader.emit({
        type: 'entity.upsert', spaceId: SPACE as never, seq: 1, occurredAt: '', schemaVersion: 1,
        entity: { ...task(3), title: 'Task 3, renamed' },
      } as never);
    });
    expect(await view.findByText('Task 3, renamed')).toBeTruthy();
  });
});
