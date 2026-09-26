// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import { mergeChatTurnFrame } from './turn-model';
import type {
  ChatHomePort,
  ChatModelOption,
  ChatPostResult,
  ChatThreadDetail,
  ChatTurnFrame,
} from './types';

/**
 * LANE 1 — THE TURN PIPELINE. Send → echo → delta / done → render, and every
 * place the viewer used to see nothing while work was happening. Each case
 * names the line it hinges on.
 */

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const CHAT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
const AGENT_MSG = '019f0000-0000-7000-8000-0000000000c1' as EntityId;
const AGENT = CHAT_HOME_FIXTURE_THREAD.turns[1]!.author;

/**
 * A port whose server side is scripted: `store` makes a frame durable (the
 * next read sees it) WITHOUT publishing it — a frame lost on the way — and
 * `publish` delivers one. `emit` does both, which is the server's normal
 * order. `reconnect` is the socket coming back.
 */
function scriptedPort(thread: ChatThreadDetail = CHAT_HOME_FIXTURE_THREAD) {
  const { port: base } = createChatHomeFixturePort([thread]);
  const listeners = new Set<(frame: ChatTurnFrame) => void>();
  const reconnects = new Set<() => void>();
  const stored: ChatTurnFrame[] = [];
  let stateOverride: ChatThreadDetail['summary']['state'] | null = null;
  let reads = 0;
  let postGate: Promise<void> | null = null;
  const port: ChatHomePort = {
    ...base,
    async readThread(rootId) {
      reads += 1;
      let detail = await base.readThread(rootId);
      for (const frame of stored) detail = mergeChatTurnFrame(detail, frame);
      if (stateOverride) detail = { ...detail, summary: { ...detail.summary, state: stateOverride } };
      return detail;
    },
    async postTurn(input): Promise<ChatPostResult> {
      if (postGate) await postGate;
      return base.postTurn(input);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeReconnect(listener) {
      reconnects.add(listener);
      return () => reconnects.delete(listener);
    },
  };
  return {
    port,
    store: (frame: ChatTurnFrame) => { stored.push(frame); },
    publish: (frame: ChatTurnFrame) => { for (const listener of listeners) listener(frame); },
    emit(frame: ChatTurnFrame) { this.store(frame); this.publish(frame); },
    reconnect: () => { for (const listener of reconnects) listener(); },
    setState: (state: ChatThreadDetail['summary']['state'] | null) => { stateOverride = state; },
    holdPosts() {
      let release = () => {};
      postGate = new Promise<void>((resolve) => { release = resolve; });
      return () => { postGate = null; release(); };
    },
    reads: () => reads,
  };
}

const delta = (seq: number, text: string, messageId = AGENT_MSG): ChatTurnFrame => ({
  type: 'chat.turn.delta', chatId: CHAT, messageId, seq, part: { kind: 'text', text },
});
const done = (messageId = AGENT_MSG): ChatTurnFrame => ({
  type: 'chat.turn.done', chatId: CHAT, messageId, usage: {},
});

async function openThread(port: ChatHomePort) {
  const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
  await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());
  await waitFor(() => expect(view.getByTestId('chat-usage-card')).toBeTruthy());
  return view;
}

function type(view: ReturnType<typeof render>, text: string) {
  fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: text } });
  fireEvent.click(view.getByRole('button', { name: /send/i }));
}

const transcript = (view: ReturnType<typeof render>) =>
  view.container.querySelector('.tch-transcript') as HTMLElement;

describe('send paints in the same frame', () => {
  /**
   * HINGES ON: `appendOptimisticTurn` in `send`. The user's words used to
   * appear only after the post AND a whole thread re-read resolved.
   */
  it('puts the user turn in the transcript before the post is acked', async () => {
    const script = scriptedPort();
    const view = await openThread(script.port);
    const release = script.holdPosts();

    type(view, 'Keep going.');

    // No waitFor: the commit the press caused already holds the echo.
    const bodies = within(transcript(view)).getAllByTestId('chat-user-body');
    expect(bodies.at(-1)?.textContent).toContain('Keep going.');
    // It is the viewer's own (right-hand) turn, and the composer is empty.
    expect(bodies.at(-1)?.closest('article')?.getAttribute('data-self')).toBe('true');
    expect((view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).value).toBe('');

    await act(async () => { release(); });
    // The stored message replaces the echo — one copy, never two.
    await waitFor(() => expect(view.getAllByText('Keep going.')).toHaveLength(1));
  });

  /**
   * HINGES ON: the catch arm's `dropTurn` + `restoreDraft` (D12).
   */
  it('a failed post takes the echo back and returns the words to the composer', async () => {
    const script = scriptedPort();
    const port: ChatHomePort = {
      ...script.port,
      postTurn: async () => { throw new Error('node refused the post'); },
    };
    const view = await openThread(port);

    type(view, 'This will fail.');
    await waitFor(() => expect(view.getByText('node refused the post')).toBeTruthy());
    expect(within(transcript(view)).queryByText('This will fail.')).toBeNull();
    expect((view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).value).toBe('This will fail.');
    expect(view.queryByTestId('chat-turn-shell')).toBeNull();
  });
});

describe('the agent turn exists before any delta', () => {
  /**
   * HINGES ON: `shellTurn` (the turn clock started in `send`). Before this the
   * only thing on screen between Send and the first part — measured 3–90s on
   * the live node — was a "thinking" line, never the agent's turn.
   */
  it('mounts a shell on Send, keeps it through the ack, and hands over to the first delta', async () => {
    const script = scriptedPort();
    const view = await openThread(script.port);
    const release = script.holdPosts();

    type(view, 'Keep going.');
    const shell = view.getByTestId('chat-turn-shell');
    expect(shell.getAttribute('data-role')).toBe('assistant');
    expect(shell.getAttribute('data-live')).toBe('true');
    // Byline names the chat's teammate; the body is empty (D12).
    expect(within(shell).getByText('Forge')).toBeTruthy();
    expect(shell.querySelector('.tch-parts')?.textContent ?? '').toBe('');
    expect(transcript(view).getAttribute('data-turn-phase')).toBe('sending');

    await act(async () => { release(); });
    await waitFor(() => expect(transcript(view).getAttribute('data-turn-phase')).toBe('waiting'));
    expect(view.getByTestId('chat-turn-shell')).toBeTruthy();

    act(() => { script.emit(delta(0, 'First words.')); });
    expect(view.getByText('First words.')).toBeTruthy();
    expect(view.queryByTestId('chat-turn-shell')).toBeNull();
    const live = view.getByText('First words.').closest('article')!;
    expect(live.getAttribute('data-live')).toBe('true');
    expect(transcript(view).getAttribute('data-turn-phase')).toBe('streaming');

    act(() => { script.emit(done()); });
    await waitFor(() => expect(transcript(view).getAttribute('data-turn-phase')).toBeNull());
    expect(live.getAttribute('data-live')).toBeNull();
  });

  it('a brand-new chat gets its echo and its shell before chat.start answers', async () => {
    const { port: base } = createChatHomeFixturePort([]);
    let release = () => {};
    const port: ChatHomePort = {
      ...base,
      startThread: {
        ...base.startThread,
        create: (input) => new Promise((resolve) => {
          release = () => resolve(base.startThread.create(input));
        }),
      },
    };
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByLabelText('Message the chat agent')).toBeTruthy());

    type(view, 'Audit the release.');
    expect(view.getByTestId('chat-user-body').textContent).toContain('Audit the release.');
    expect(view.getByTestId('chat-turn-shell')).toBeTruthy();

    await act(async () => { release(); });
    await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());
    // The stand-in became the chat: still one copy of the words, shell still up.
    expect(view.getAllByText('Audit the release.').filter((el) => el.closest('.tch-transcript'))).toHaveLength(1);
    expect(view.getByTestId('chat-turn-shell')).toBeTruthy();
  });
});

describe('no delta is lost', () => {
  /**
   * HINGES ON: the `gap` re-read in the frame handler. A delta more than one
   * step ahead of everything seen means frames were dropped; nothing re-read
   * the thread, so the hole stayed until a reload.
   */
  it('a seq gap re-reads the thread and fills the hole', async () => {
    const script = scriptedPort();
    const view = await openThread(script.port);

    act(() => { script.emit(delta(0, 'Part zero.')); });
    await waitFor(() => expect(view.getByText('Part zero.')).toBeTruthy());
    // Wait out the unknown-message refresh the first delta triggers.
    await waitFor(() => expect(script.reads()).toBeGreaterThan(1));
    const before = script.reads();

    script.store(delta(1, 'Part one, never published.'));
    act(() => { script.emit(delta(2, 'Part two.')); });

    await waitFor(() => expect(view.getByText('Part one, never published.')).toBeTruthy());
    expect(script.reads()).toBe(before + 1);
  });

  /**
   * HINGES ON: the `subscribeReconnect` effect. Chat frames are not durable
   * events: a socket that dropped mid-turn lost every delta of the gap, and a
   * done lost in it left the composer "working" until a reload.
   */
  it('a reconnect mid-turn restores the parts published while the socket was down', async () => {
    const script = scriptedPort();
    const view = await openThread(script.port);
    act(() => { script.emit(delta(0, 'Before the drop.')); });
    await waitFor(() => expect(view.getByText('Before the drop.')).toBeTruthy());

    script.store(delta(1, 'During the drop.'));
    act(() => { script.reconnect(); });
    await waitFor(() => expect(view.getByText('During the drop.')).toBeTruthy());
    expect(view.getByTestId('tch-send-working')).toBeTruthy();
  });

  it('a turn that finished while the socket was down settles on reconnect', async () => {
    const script = scriptedPort();
    const view = await openThread(script.port);
    act(() => { script.emit(delta(0, 'Working on it.')); });
    await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());

    script.store(delta(1, 'All done.'));
    script.store(done());
    script.setState('idle');
    act(() => { script.reconnect(); });

    await waitFor(() => expect(view.getByText('All done.')).toBeTruthy());
    await waitFor(() => expect(view.queryByTestId('tch-send-working')).toBeNull());
    expect(transcript(view).getAttribute('data-turn-phase')).toBeNull();
  });
});

describe('a done settles the turn it ends', () => {
  /**
   * HINGES ON: `mergeChatTurnFrame`'s done arm clearing `turnInFlight`, and
   * the re-read a done triggers. A claimed turn that finished WITHOUT parts
   * while being watched stayed marked in flight: its bubble stayed empty and
   * its durable body never appeared until a reload.
   */
  it('a claimed turn that ends with no parts shows its durable body', async () => {
    const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    thread.summary.state = 'streaming';
    thread.turns = [thread.turns[0]!, {
      messageId: AGENT_MSG, role: 'assistant', author: AGENT, createdAt: '2026-08-13T08:20:00.000Z',
      body: 'Agent turn in progress.', parts: [], turnInFlight: true,
    }];
    const { port: base, controls } = createChatHomeFixturePort([thread]);
    let finished = false;
    const port: ChatHomePort = {
      ...base,
      async readThread(rootId) {
        const detail = await base.readThread(rootId);
        if (!finished) return detail;
        return {
          ...detail,
          summary: { ...detail.summary, state: 'idle' },
          turns: detail.turns.map((turn) => (turn.messageId === AGENT_MSG
            ? { ...turn, body: 'Agent turn completed.', turnInFlight: false }
            : turn)),
        };
      },
    };
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());
    expect(view.queryByText('Agent turn in progress.')).toBeNull();

    finished = true;
    act(() => { controls.emit(done()); });
    await waitFor(() => expect(view.getByText('Agent turn completed.')).toBeTruthy());
    expect(view.queryByText('Agent turn in progress.')).toBeNull();
  });

  it('a turn that ends in an error is held as failed, with its message', async () => {
    const script = scriptedPort();
    const view = await openThread(script.port);
    act(() => {
      script.emit({ type: 'chat.turn.delta', chatId: CHAT, messageId: AGENT_MSG, seq: 0, part: { kind: 'error', message: 'runtime died' } });
      script.emit(done());
    });
    await waitFor(() => expect(transcript(view).getAttribute('data-turn-phase')).toBe('failed'));
  });
});

describe('reload mid-turn resumes the live turn', () => {
  /**
   * HINGES ON: the clock started in the select effect when the opened thread
   * is already streaming. The in-flight message is the live turn, later deltas
   * render into it, and the done settles it.
   */
  it('marks the in-flight turn live and keeps streaming into it', async () => {
    const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    thread.summary.state = 'streaming';
    thread.turns = [thread.turns[0]!, {
      messageId: AGENT_MSG, role: 'assistant', author: AGENT, createdAt: '2026-08-13T08:20:00.000Z',
      body: 'Agent turn in progress.', turnInFlight: true,
      parts: [{ seq: 0, kind: 'text', text: 'Already said before the reload.' }],
    }];
    const script = scriptedPort(thread);
    const view = render(<ChatHomeScreen port={script.port} spaceId={SPACE_ID} models={MODELS} />);

    await waitFor(() => expect(view.getByText('Already said before the reload.')).toBeTruthy());
    const article = view.getByText('Already said before the reload.').closest('article')!;
    expect(article.getAttribute('data-live')).toBe('true');
    expect(transcript(view).getAttribute('data-turn-phase')).toBe('streaming');
    expect(view.queryByTestId('chat-turn-shell')).toBeNull();

    act(() => { script.emit(delta(1, 'And this after it.')); });
    expect(within(article).getByText('And this after it.')).toBeTruthy();

    act(() => { script.emit(done()); });
    await waitFor(() => expect(view.queryByTestId('tch-send-working')).toBeNull());
  });
});
