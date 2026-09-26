// @vitest-environment jsdom
/**
 * L5's SWEEP OF THE SCREEN'S OWN SEAMS: switching threads, a send that fails,
 * and the refusal a started thread must not inherit from the new-chat picks.
 *
 * Every case here was reproduced on the live node (2026-09-26) before it was
 * written down, and each names the line it guards. (The stale-`state` re-open
 * — a finished turn coming back "working" — was fixed at the PORT by #875 and
 * is pinned in `real-port.test.ts`; it is not restated here.)
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption, ChatThreadDetail } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const A = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
const B = '019f0000-0000-7000-8000-0000000000bb' as EntityId;
const TURN = '019f0000-0000-7000-8000-0000000000e1' as EntityId;

/** A second, OLDER thread — cold start opens A, so B is reached by a click. */
function secondThread(): ChatThreadDetail {
  const second = structuredClone(CHAT_HOME_FIXTURE_THREAD);
  second.summary.rootId = B;
  second.summary.title = 'Retire the flaky migration';
  second.summary.updatedAt = '2026-08-11T08:20:00.000Z';
  second.summary.config = { ...second.summary.config, mode: 'ask', teammateLabel: 'Researcher' };
  second.turns = second.turns.map((turn, index) => ({
    ...turn,
    messageId: `019f0000-0000-7000-8000-0000000000b${index}` as EntityId,
  }));
  return second;
}

function mount(port: ChatHomePort) {
  const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
  return view;
}

const title = (view: ReturnType<typeof mount>) =>
  view.container.querySelector('.tch-title strong')?.textContent;
const openRow = (view: ReturnType<typeof mount>, name: RegExp) =>
  fireEvent.click(view.getByRole('button', { name }));
const composer = (view: ReturnType<typeof mount>) =>
  view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;

async function openedOn(view: ReturnType<typeof mount>, expected: string) {
  await waitFor(() => expect(title(view)).toBe(expected));
  await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());
}

describe('switching threads', () => {
  it('the outgoing thread’s phase, title, pins and ledger do not carry into the one being opened', async () => {
    // A built something, so its ledger panel has a row to (wrongly) carry over.
    const first = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    first.turns.push({
      messageId: '019f0000-0000-7000-8000-0000000000e3' as EntityId,
      role: 'assistant', author: null, createdAt: '2026-08-13T08:21:00.000Z', body: '',
      parts: [
        { kind: 'tool_call', seq: 0, toolCallId: 'tc-create', name: 'mcp__tm8__tm8_act',
          args: { operation: 'entities.create', body: { kind: 'task', title: 'Only in A' } }, state: 'completed' },
        { kind: 'tool_result', seq: 1, toolCallId: 'tc-create',
          content: { entity: { id: '01a00000-00aa-7000-8000-0000000000a1', kind: 'task', title: 'Only in A' } } },
      ],
    });
    const fixture = createChatHomeFixturePort([first, secondThread()]);
    let releaseB: (() => void) | null = null;
    const port: ChatHomePort = {
      ...fixture.port,
      async readThread(rootId) {
        if (rootId === B) await new Promise<void>((resolve) => { releaseB = resolve; });
        return fixture.port.readThread(rootId);
      },
    };
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} onOpenEntity={() => {}} />,
    );
    await openedOn(view, 'Plan the launch sequence');
    expect(view.getByTestId('ledger-panel')).toBeTruthy();
    act(() => {
      fixture.controls.emit({
        type: 'chat.turn.delta', chatId: A, messageId: TURN, seq: 0,
        part: { kind: 'text', text: 'Working on it.' },
      });
    });
    await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());

    // B is opened and its read has NOT landed.
    openRow(view, /Retire the flaky migration/);
    expect(view.getByTestId('chat-detail-loading')).toBeTruthy();
    // A's working button would have stopped B — the thread now selected.
    expect(view.queryByTestId('tch-send-working')).toBeNull();
    // B's own row speaks for it from the first frame (D26): title, teammate, mode.
    expect(title(view)).toBe('Retire the flaky migration');
    expect(view.container.querySelector('.tch-title span')?.textContent).toBe('with Researcher');
    expect(view.getByTestId('tch-mode').textContent).toContain('ask');
    // A's entities are not offered as B's.
    expect(view.queryByTestId('ledger-panel')).toBeNull();

    act(() => releaseB?.());
    await openedOn(view, 'Retire the flaky migration');
  });
});

describe('a failed send', () => {
  function failingPort(options: { failPost?: boolean; failReadAfterPost?: boolean } = {}) {
    const fixture = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, secondThread()]);
    let posted = false;
    const port: ChatHomePort = {
      ...fixture.port,
      async postTurn(input) {
        if (options.failPost) throw new Error('The node refused the message.');
        const result = await fixture.port.postTurn(input);
        posted = true;
        return result;
      },
      async readThread(rootId) {
        if (posted && options.failReadAfterPost) throw new Error('Failed to fetch');
        return fixture.port.readThread(rootId);
      },
    };
    return { port, fixture };
  }

  it('keeps the draft, and its error stays with that thread rather than following the viewer', async () => {
    const { port } = failingPort({ failPost: true });
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    fireEvent.change(composer(view), { target: { value: 'This must survive.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('The node refused the message.'));
    expect(composer(view).value).toBe('This must survive.');

    openRow(view, /Retire the flaky migration/);
    await openedOn(view, 'Retire the flaky migration');
    expect(view.queryByText('The node refused the message.')).toBeNull();
    expect(composer(view).value).toBe('');

    openRow(view, /Plan the launch sequence/);
    await openedOn(view, 'Plan the launch sequence');
    expect(view.getByText('The node refused the message.')).toBeTruthy();
    expect(composer(view).value).toBe('This must survive.');
  });

  it('a post that fails AFTER the viewer left files its error under the thread it was typed in', async () => {
    const fixture = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, secondThread()]);
    let reject: ((error: Error) => void) | null = null;
    const port: ChatHomePort = {
      ...fixture.port,
      async postTurn() {
        await new Promise<void>((_, fail) => { reject = fail; });
        throw new Error('unreachable');
      },
    };
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    fireEvent.change(composer(view), { target: { value: 'Typed in A.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(reject).not.toBeNull());
    openRow(view, /Retire the flaky migration/);
    await openedOn(view, 'Retire the flaky migration');
    await act(async () => { reject?.(new Error('The node refused the message.')); });
    expect(view.queryByText('The node refused the message.')).toBeNull();
    expect(composer(view).value).toBe('');
    openRow(view, /Plan the launch sequence/);
    await openedOn(view, 'Plan the launch sequence');
    expect(view.getByText('The node refused the message.')).toBeTruthy();
    expect(composer(view).value).toBe('Typed in A.');
  });

  it('a send in another thread does not wipe the failure filed under this one', async () => {
    const fixture = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, secondThread()]);
    const port: ChatHomePort = {
      ...fixture.port,
      async postTurn(input) {
        if (input.chatId === A) throw new Error('The node refused the message.');
        return fixture.port.postTurn(input);
      },
    };
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    fireEvent.change(composer(view), { target: { value: 'Fails in A.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(view.getByText('The node refused the message.')).toBeTruthy());

    openRow(view, /Retire the flaky migration/);
    await openedOn(view, 'Retire the flaky migration');
    fireEvent.change(composer(view), { target: { value: 'Lands in B.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(fixture.controls.posts).toHaveLength(1));

    openRow(view, /Plan the launch sequence/);
    await openedOn(view, 'Plan the launch sequence');
    expect(composer(view).value).toBe('Fails in A.');
    expect(view.getByText('The node refused the message.')).toBeTruthy();
  });

  it('a second failure in another thread does not overwrite the first — each thread keeps its own', async () => {
    const fixture = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, secondThread()]);
    const port: ChatHomePort = {
      ...fixture.port,
      async postTurn(input) {
        throw new Error(input.chatId === A ? 'A was refused.' : 'B was refused.');
      },
    };
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    fireEvent.change(composer(view), { target: { value: 'Fails in A.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(view.getByText('A was refused.')).toBeTruthy());
    openRow(view, /Retire the flaky migration/);
    await openedOn(view, 'Retire the flaky migration');
    fireEvent.change(composer(view), { target: { value: 'Fails in B.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(view.getByText('B was refused.')).toBeTruthy());
    expect(view.queryByText('A was refused.')).toBeNull();

    openRow(view, /Plan the launch sequence/);
    await openedOn(view, 'Plan the launch sequence');
    expect(view.getByText('A was refused.')).toBeTruthy();
    expect(view.queryByText('B was refused.')).toBeNull();
  });

  it('a failed follow-up does not take the working button off a turn that is still streaming', async () => {
    const { port, fixture } = failingPort({ failPost: true });
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    act(() => {
      fixture.controls.emit({
        type: 'chat.turn.delta', chatId: A, messageId: TURN, seq: 0,
        part: { kind: 'text', text: 'Still working.' },
      });
    });
    await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());
    fireEvent.change(composer(view), { target: { value: 'And one more thing.' } });
    fireEvent.keyDown(composer(view), { key: 'Enter' });
    await waitFor(() => expect(view.getByText('The node refused the message.')).toBeTruthy());
    expect(view.getByTestId('tch-send-working')).toBeTruthy();
  });

  it('a message the server STORED is not reported as failed when only the re-read after it throws', async () => {
    const { port, fixture } = failingPort({ failReadAfterPost: true });
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    fireEvent.change(composer(view), { target: { value: 'Stored, then the read fails.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(fixture.controls.posts).toHaveLength(1));
    await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());
    expect(view.queryByText('Failed to fetch')).toBeNull();
    // Cleared, because it was sent: offering it again invites a duplicate.
    expect(composer(view).value).toBe('');
  });

  it('an ACKED post whose re-read fails after the viewer left files no error under its thread', async () => {
    const fixture = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, secondThread()]);
    let posted = false;
    let failOnce: (() => void) | null = null;
    const port: ChatHomePort = {
      ...fixture.port,
      async postTurn(input) {
        const result = await fixture.port.postTurn(input);
        posted = true;
        return result;
      },
      async readThread(rootId) {
        // The re-read right after the ack hangs, then fails — once.
        if (posted && rootId === A && failOnce === null) {
          await new Promise<void>((_, reject) => { failOnce = () => reject(new Error('Failed to fetch')); });
        }
        return fixture.port.readThread(rootId);
      },
    };
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    fireEvent.change(composer(view), { target: { value: 'Stored before I left.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(failOnce).not.toBeNull());
    openRow(view, /Retire the flaky migration/);
    await openedOn(view, 'Retire the flaky migration');
    await act(async () => { failOnce?.(); });
    openRow(view, /Plan the launch sequence/);
    await openedOn(view, 'Plan the launch sequence');
    expect(fixture.controls.posts).toHaveLength(1);
    expect(view.queryByText('Failed to fetch')).toBeNull();
  });

  it('keeps the composer focusable while our write is in flight — read-only, never disabled', async () => {
    const fixture = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    let release: (() => void) | null = null;
    const port: ChatHomePort = {
      ...fixture.port,
      async postTurn(input) {
        await new Promise<void>((resolve) => { release = resolve; });
        return fixture.port.postTurn(input);
      },
    };
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    fireEvent.change(composer(view), { target: { value: 'Keep my caret.' } });
    composer(view).focus();
    fireEvent.keyDown(composer(view), { key: 'Enter' });
    await waitFor(() => expect(view.getByTestId('chat-home-screen').querySelector('[data-phase="posting-turn"]')).toBeTruthy());
    /* A browser BLURS a disabled field, so `disabled` here cost the writer
       their caret on every send (measured live). jsdom does not model that
       blur, which is why this asserts the attribute that causes it. */
    expect(composer(view).disabled).toBe(false);
    expect(composer(view).readOnly).toBe(true);
    act(() => release?.());
    await waitFor(() => expect(composer(view).readOnly).toBe(false));
  });
});

describe('the refusal belongs to a NEW chat', () => {
  it('a started thread still takes a turn when the roster lists no agent teammate', async () => {
    const fixture = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    const port: ChatHomePort = { ...fixture.port, async listTeammates() { return []; } };
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    expect(view.queryByText('No agent teammate is available in this space.')).toBeNull();
    fireEvent.change(composer(view), { target: { value: 'Carry on.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(fixture.controls.posts).toHaveLength(1));

    // …and a NEW chat is still refused, because it would name nobody.
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    expect(view.getByText('No agent teammate is available in this space.')).toBeTruthy();
  });

  it('a model the catalog stops listing does not refuse new chats beside a picker full of models', async () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    const retired: ChatModelOption[] = [
      { model: 'claude-opus-5', label: 'Opus 5', provider: 'Anthropic', agentTool: 'claude-code' },
    ];
    view.rerender(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={retired} />);
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Opus 5'));
    expect(view.queryByText('No model is available from the launch catalog.')).toBeNull();
  });
});

describe('the thread rail', () => {
  it('names a row’s model in the catalog’s words, never the raw id the port carries', async () => {
    const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    // What the real port writes: `modelLabel: item.model`.
    thread.summary.config.modelLabel = thread.summary.config.model;
    const { port } = createChatHomeFixturePort([thread]);
    const view = mount(port);
    await openedOn(view, 'Plan the launch sequence');
    const meta = view.container.querySelector('.tch-thread__meta')?.textContent ?? '';
    expect(meta).toContain('Sonnet 4.5');
    expect(meta).not.toContain('claude-sonnet-4-5');
  });
});
