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

  /**
   * HINGES ON: `restoreDraft` putting back `typed` — the box as it was — and
   * not `draftBody`, the trimmed text that was posted. Indentation and blank
   * lines the writer left are theirs to keep.
   */
  it('a failed post restores the draft exactly as typed, whitespace and all', async () => {
    const script = scriptedPort();
    const port: ChatHomePort = {
      ...script.port,
      postTurn: async () => { throw new Error('node refused the post'); },
    };
    const view = await openThread(port);
    const typed = '  Indented first line\nthen a blank line after\n\n';

    type(view, typed);
    await waitFor(() => expect(view.getByText('node refused the post')).toBeTruthy());
    expect((view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).value).toBe(typed);
  });
});

describe('a failed send leaves a turn already running alone', () => {
  /**
   * HINGES ON: `stillLive` in `send`'s catch (raised by L5). Our post failing
   * says nothing about the turn already streaming in this thread; dropping to
   * idle hid it (no Stop, no live turn) until its next frame.
   */
  it('keeps streaming, and the running turn stays the live one', async () => {
    const script = scriptedPort();
    const port: ChatHomePort = {
      ...script.port,
      postTurn: async () => { throw new Error('node refused the post'); },
    };
    const view = await openThread(port);
    act(() => { script.emit(delta(0, 'Still working on the last one.')); });
    await waitFor(() => expect(transcript(view).getAttribute('data-turn-phase')).toBe('streaming'));

    // The button is Stop while a turn streams; Enter still sends.
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'And another thing.' } });
    fireEvent.keyDown(view.getByLabelText('Message the chat agent'), { key: 'Enter' });
    await waitFor(() => expect(view.getByText('node refused the post')).toBeTruthy());
    expect(transcript(view).getAttribute('data-turn-phase')).toBe('streaming');
    expect(view.getByTestId('tch-send-working')).toBeTruthy();
    expect(view.getByText('Still working on the last one.').closest('article')?.getAttribute('data-live')).toBe('true');
  });
});

describe('review of #875', () => {
  /**
   * B1 — HINGES ON: `if (!acked) restoreDraft()` running OUTSIDE the
   * active-thread gate. The box is cleared on Send, so a failure that lands
   * after the viewer switched away lost the words entirely (main cleared the
   * draft only on success, so this was a regression the echo introduced).
   */
  it('a post that fails after the viewer switched away keeps the words', async () => {
    const second = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    second.summary.rootId = '019f0000-0000-7000-8000-0000000000aa' as EntityId;
    second.summary.title = 'Retire the flaky migration';
    second.summary.updatedAt = '2026-08-11T08:20:00.000Z';
    const { port: base } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, second]);
    let fail = () => {};
    const port: ChatHomePort = {
      ...base,
      postTurn: () => new Promise((_, reject) => { fail = () => reject(new Error('node refused')); }),
    };
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    const title = () => view.container.querySelector('.tch-title strong')?.textContent;
    await waitFor(() => expect(title()).toBe('Plan the launch sequence'));
    await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());
    type(view, 'Words I typed.');
    fireEvent.click(view.getByRole('button', { name: /Retire the flaky migration/ }));
    await waitFor(() => expect(title()).toBe('Retire the flaky migration'));
    await act(async () => { fail(); });
    fireEvent.click(view.getByRole('button', { name: /Plan the launch sequence/ }));
    await waitFor(() => expect(title()).toBe('Plan the launch sequence'));
    expect((view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).value).toBe('Words I typed.');
  });

  /**
   * S1 — HINGES ON: the reconnect effect's `clockFromRead` in its streaming
   * arm. A turn that started while the socket was down had no clock, so the
   * turn in progress read null — no shell, no live row — until its next frame.
   */
  it('a reconnect that finds a turn running starts its clock', async () => {
    const script = scriptedPort();
    const view = await openThread(script.port);
    expect(transcript(view).getAttribute('data-turn-phase')).toBeNull();

    script.setState('streaming');
    act(() => { script.reconnect(); });
    await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());
    expect(transcript(view).getAttribute('data-turn-phase')).toBe('waiting');
    expect(view.getByTestId('chat-turn-shell')).toBeTruthy();
  });

  /**
   * N1a — HINGES ON: `refreshDetail` COALESCING (`running.set(rootId, true)`).
   * A done that lands while an earlier re-read is in flight must get a read of
   * its own: the in-flight one predates the final body, and dropping the done's
   * request left the finished turn without it.
   */
  it('a done during an in-flight re-read still gets the final body', async () => {
    const claimed = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    claimed.summary.state = 'streaming';
    claimed.turns = [claimed.turns[0]!, {
      messageId: AGENT_MSG, role: 'assistant', author: AGENT, createdAt: '2026-08-13T08:20:00.000Z',
      body: 'Agent turn in progress.', parts: [], turnInFlight: true,
    }];
    const finished: ChatThreadDetail = {
      ...claimed,
      summary: { ...claimed.summary, state: 'idle' },
      turns: [claimed.turns[0]!, { ...claimed.turns[1]!, body: 'Agent turn completed.', turnInFlight: false }],
    };
    const { port: base, controls } = createChatHomeFixturePort([claimed]);
    let final = false;
    let gate: Promise<void> | null = null;
    let reads = 0;
    const port: ChatHomePort = {
      ...base,
      async readThread() {
        reads += 1;
        // The snapshot is taken when the read STARTS; the hold only delays it.
        const snapshot = structuredClone(final ? finished : claimed);
        if (gate) await gate;
        return snapshot;
      },
    };
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());
    const before = reads;

    let release = () => {};
    gate = new Promise<void>((resolve) => { release = resolve; });
    // A seq gap starts a re-read, held in flight with the pre-done snapshot.
    act(() => {
      controls.emit({ type: 'chat.turn.delta', chatId: CHAT, messageId: AGENT_MSG, seq: 1, part: { kind: 'done' } });
    });
    await waitFor(() => expect(reads).toBe(before + 1));
    final = true;
    act(() => { controls.emit(done()); });
    gate = null;
    await act(async () => { release(); });

    await waitFor(() => expect(view.getByText('Agent turn completed.')).toBeTruthy());
    expect(reads).toBe(before + 2);
  });

  /**
   * N1b — HINGES ON: the ack RE-KEY (`settleOptimisticTurn`). When the stored
   * copy's words differ from the echo (the server normalised them), only the
   * id can tie the two together — the body match cannot.
   */
  it('the ack re-key replaces the echo even when the stored words differ', async () => {
    const script = scriptedPort();
    const port: ChatHomePort = {
      ...script.port,
      postTurn: (input) => script.port.postTurn({ ...input, body: `${input.body} [stored]` }),
    };
    const view = await openThread(port);
    type(view, 'Keep going.');
    await waitFor(() => expect(within(transcript(view)).getByText('Keep going. [stored]')).toBeTruthy());
    expect(within(transcript(view)).queryByText('Keep going.')).toBeNull();
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
    // D22: nothing the user typed waits behind a loading state, and the header
    // shows no title until the server names the chat — not a placeholder.
    expect(view.queryByTestId('chat-home-loading')).toBeNull();
    expect(view.queryByTestId('chat-detail-loading')).toBeNull();
    expect(view.container.querySelector('.tch-title strong')?.textContent).toBe('');

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

describe('the done part names how a turn ended', () => {
  /**
   * N3 — HINGES ON: `turnFailureOf` deferring to the terminal done part's
   * `reason`. An error ITEM inside a turn that the runtime still closed with
   * `success` is not a failed turn; only `reason: 'error'` is.
   */
  it('an error item in a turn that ended in success is not held as failed', async () => {
    const script = scriptedPort();
    const view = await openThread(script.port);
    act(() => {
      script.emit({ type: 'chat.turn.delta', chatId: CHAT, messageId: AGENT_MSG, seq: 0, part: { kind: 'error', message: 'a tool hiccup' } });
      script.emit({ type: 'chat.turn.delta', chatId: CHAT, messageId: AGENT_MSG, seq: 1, part: { kind: 'done', reason: 'success' } });
      script.emit(done());
    });
    await waitFor(() => expect(view.queryByTestId('tch-send-working')).toBeNull());
    expect(transcript(view).getAttribute('data-turn-phase')).toBeNull();
  });

  /**
   * HINGES ON: `turnFailureOf` judging only the LAST attempt — the parts after
   * the previous done. A turn whose `complete_chat_turn` did not land is
   * re-claimed and re-run into the SAME agent message, seq continuing (live:
   * turn 01a0d439, done at seq 18, then seq 19–34 fifty minutes later), so one
   * message can carry two done parts. Attempt 1 is durable (in the snapshot);
   * attempt 2 streams.
   */
  const part = (seq: number, item: Extract<ChatTurnFrame, { type: 'chat.turn.delta' }>['part']): ChatTurnFrame => ({
    type: 'chat.turn.delta', chatId: CHAT, messageId: AGENT_MSG, seq, part: item,
  });

  it('a re-run that succeeds after a failed first attempt is not held as failed', async () => {
    const script = scriptedPort();
    script.store(part(0, { kind: 'error', message: 'runtime died' }));
    script.store(part(1, { kind: 'done', reason: 'error' }));
    const view = await openThread(script.port);

    act(() => {
      script.emit(delta(2, 'Second attempt got there.'));
      script.emit(part(3, { kind: 'done', reason: 'success' }));
      script.emit(done());
    });
    await waitFor(() => expect(view.queryByTestId('tch-send-working')).toBeNull());
    expect(transcript(view).getAttribute('data-turn-phase')).toBeNull();
  });

  it('a re-run that fails after a clean first attempt is held as failed', async () => {
    const script = scriptedPort();
    script.store(delta(0, 'First attempt answered.'));
    script.store(part(1, { kind: 'done', reason: 'success' }));
    const view = await openThread(script.port);

    act(() => {
      script.emit(part(2, { kind: 'error', message: 'second attempt died' }));
      script.emit(part(3, { kind: 'done', reason: 'error' }));
      script.emit(done());
    });
    await waitFor(() => expect(transcript(view).getAttribute('data-turn-phase')).toBe('failed'));
  });

  /**
   * HINGES ON: the previous-done SLICE in `turnFailureOf` (#882 review, item
   * 10). An older node's done parts carry no `reason`, so the verdict falls
   * back to an error part — and without the slice, attempt 1's error is still
   * in scope and a clean re-run reads as failed.
   */
  it('an older node re-run that is clean after an errored first attempt is not held as failed', async () => {
    const script = scriptedPort();
    script.store(part(0, { kind: 'error', message: 'runtime died' }));
    script.store(part(1, { kind: 'done' }));
    const view = await openThread(script.port);

    act(() => {
      script.emit(delta(2, 'Second attempt got there.'));
      script.emit(part(3, { kind: 'done' }));
      script.emit(done());
    });
    await waitFor(() => expect(view.queryByTestId('tch-send-working')).toBeNull());
    expect(transcript(view).getAttribute('data-turn-phase')).toBeNull();
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
