// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption, ChatThreadDetail, ChatTurn } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  {
    model: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    provider: 'Anthropic',
    agentTool: 'claude-code',
  },
  {
    model: 'gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    provider: 'OpenAI',
    agentTool: 'codex',
  },
];

function placeholderTurn(): ChatTurn {
  return {
    messageId: '019f0000-0000-7000-8000-000000000099' as EntityId,
    role: 'assistant',
    author: CHAT_HOME_FIXTURE_THREAD.turns[1]!.author,
    createdAt: '2026-08-13T08:19:30.000Z',
    // Written by the server onto the message body when the turn is claimed.
    body: 'Agent turn in progress.',
    parts: [],
  };
}

/**
 * The fixture port models the user's post and stops there. The server does one
 * more thing the suppression rule turns on: it writes the placeholder when it
 * CLAIMS the turn, which is strictly AFTER that post. `claimed` is what the
 * claim adds — pass `[]` for the window where the post has landed and the
 * claim has not.
 */
function claimingPort(thread: ChatThreadDetail, claimed: readonly ChatTurn[]): ChatHomePort {
  const { port: base } = createChatHomeFixturePort([thread]);
  let posted = false;
  return {
    ...base,
    async postTurn(input) {
      const result = await base.postTurn(input);
      posted = true;
      return result;
    },
    async readThread(rootId) {
      const detail = await base.readThread(rootId);
      return posted ? { ...detail, turns: [...detail.turns, ...claimed] } : detail;
    },
  };
}

async function sendInto(port: ChatHomePort) {
  const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
  await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
  fireEvent.change(view.getByLabelText('Message the chat agent'), {
    target: { value: 'Keep going.' },
  });
  fireEvent.click(view.getByRole('button', { name: /send/i }));
  await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());
  return view;
}

describe('Chat Home', () => {
  /**
   * THE PANEL IS THE NAVIGATION (revision 14). The surface is two panes and
   * the left one is the only conversation selector — a working-set tab strip
   * above the right pane existed briefly and was removed, because two
   * selectors for one selection is the redundancy this surface keeps shedding.
   * So the click that moves the right pane has to be a PANEL row, and this is
   * the case that says so. It needs two threads; the shared fixture ships one,
   * which is why nothing pinned this before.
   */
  it('opens a panel row in the right pane, leaving the panel itself whole', async () => {
    const second = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    second.summary.rootId = '019f0000-0000-7000-8000-0000000000aa' as EntityId;
    second.summary.title = 'Retire the flaky migration';
    // OLDER than the shipped fixture, so `listThreads` (most-recent-first)
    // puts it second and cold start does NOT auto-open it — otherwise the
    // click below would assert nothing.
    second.summary.updatedAt = '2026-08-11T08:20:00.000Z';

    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, second]);
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);

    const titles = () =>
      [...view.container.querySelectorAll('.tch-thread__title')].map((n) => n.textContent);
    await waitFor(() => expect(titles()).toHaveLength(2));
    const before = titles();
    // Cold start opened the most recent, so the pane starts on the OTHER one.
    // (Waited for, not read straight off: the list and the thread detail are
    // two reads, and the head still says "New conversation" until the second
    // one lands.)
    await waitFor(() =>
      expect(view.container.querySelector('.tch-title strong')?.textContent)
        .toBe('Plan the launch sequence'),
    );

    fireEvent.click(view.getByRole('button', { name: /Retire the flaky migration/ }));

    await waitFor(() =>
      expect(view.container.querySelector('.tch-title strong')?.textContent)
        .toBe('Retire the flaky migration'),
    );
    // The inventory does not reorder, filter or shrink when you read one of
    // its rows — selecting is not consuming.
    expect(titles()).toEqual(before);
  });

  it('renders a thread, the entities its calls touched, and actual usage', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);

    // The tool call itself draws nothing; only its ledger line, and the usage.
    await waitFor(() => expect(view.getAllByTestId('chat-ledger-reads')).toHaveLength(1));
    /* Exact sentence, minus the line's aria-hidden expansion caret (S3b). */
    const readLine = view.getByTestId('chat-ledger-reads').cloneNode(true) as HTMLElement;
    readLine.querySelectorAll('[aria-hidden]').forEach((el) => el.remove());
    expect(readLine.textContent).toBe('Read 1 task');
    expect(view.queryByTestId('chat-tool-card')).toBeNull();
    expect(view.getByTestId('chat-usage-card').textContent).toContain('$0.0073');
    // A configured thread still SAYS what it runs as; it just cannot be edited.
    expect((view.getByLabelText('Chat teammate') as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText('Chat mode') as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText('Chat model') as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByLabelText('Chat mode').textContent).toContain('plan');
    // The pinned state is the disabled triggers themselves — the foot carries
    // controls, not copy (user ruling 2026-08-18).
    expect(view.queryByText('pinned for this thread')).toBeNull();
  });

  it('creates the chat and its opening turn in ONE call', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        newMutationId={(prefix) => `${prefix}:test`}
      />,
    );

    await waitFor(() => expect(view.getByRole('button', { name: /new chat/i })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    /* R4: a NEW thread's teammate, mode and model are all drop-ups on the
       composer's own foot — there is no configuration panel above it. */
    fireEvent.click(view.getByLabelText('Chat teammate'));
    expect(
      within(view.getByTestId('tch-teammate-menu')).getAllByRole('option').length,
    ).toBeGreaterThan(0);
    fireEvent.keyDown(view.getByLabelText('Chat teammate'), { key: 'Escape' });

    fireEvent.click(view.getByLabelText('Chat model'));
    /* The coordinator runs claude-code only: the codex row is DRAWN, disabled,
       with the reason — never silently omitted (ac_10). Clicking it does nothing. */
    const codexRow = view.getByTestId('tch-model-gpt-5.6-sol');
    expect(codexRow.getAttribute('aria-disabled')).toBe('true');
    expect(codexRow.textContent).toContain('Claude Code only');
    fireEvent.click(codexRow);
    fireEvent.click(view.getByTestId('tch-model-claude-sonnet-4-5'));
    fireEvent.click(view.getByLabelText('Chat mode'));
    fireEvent.click(view.getByTestId('tch-mode-build'));
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Audit the release blockers.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    // ONE call, carrying the body AND the configuration. Before 176 this was
    // two — a message, then a binding row keyed to it — and the composer's
    // `configuring` phase named the window in between, in which a message
    // existed that was not yet a chat. There is no such window now, and no
    // `anchorId`: a chat anchors its own transcript, so bare Home names no
    // subject rather than borrowing the seeded default channel's identity.
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({
      spaceId: SPACE_ID,
      body: 'Audit the release blockers.',
      model: 'claude-sonnet-4-5',
      mode: 'build',
      clientMutationId: 'chat-start:test',
    });
    expect(controls.roots[0]).not.toHaveProperty('aboutId');
    expect(controls.posts).toHaveLength(0);
    expect(view.getByTestId('tch-send-working')).toBeTruthy();
  });

  it('offers Explain and persists it in the write-once chat configuration', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        newMutationId={(prefix) => `${prefix}:explain-test`}
      />,
    );

    await waitFor(() => expect(view.getByRole('button', { name: /new chat/i })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    fireEvent.click(view.getByLabelText('Chat mode'));
    fireEvent.click(view.getByTestId('tch-mode-explain'));
    // The trigger states the selection without being opened.
    expect(view.getByLabelText('Chat mode').textContent).toContain('explain');
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Explain the request flow with a diagram.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({ mode: 'explain' });
    await waitFor(() => {
      expect((view.getByLabelText('Chat mode') as HTMLButtonElement).disabled).toBe(true);
    });
    expect(view.getByLabelText('Chat mode').textContent).toContain('explain');
    expect(view.queryByText('pinned for this thread')).toBeNull();
  });

  it('appends a streamed part by seq and settles on done', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    const rootId = controls.roots[0]?.aboutId ?? '019f0000-0000-7000-8000-000000000010';
    const messageId = '019f0000-0000-7000-8000-000000000077' as EntityId;

    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        chatId: rootId as EntityId,
        messageId,
        seq: 0,
        part: { kind: 'text', text: 'Live result arrived.' },
      });
    });
    await waitFor(() => expect(view.getByText('Live result arrived.')).toBeTruthy());
    expect(view.getByTestId('tch-send-working')).toBeTruthy();

    act(() => {
      controls.emit({
        type: 'chat.turn.done',
        chatId: rootId as EntityId,
        messageId,
        usage: {},
      });
    });
    await waitFor(() => expect(view.queryByTestId('tch-send-working')).toBeNull());
    expect(view.getAllByTestId('chat-usage-card')).toHaveLength(1);
  });

  it('keeps new chat visibly unavailable when the config op is absent', async () => {
    const fixture = createChatHomeFixturePort();
    const port: ChatHomePort = {
      ...fixture.port,
      startThread: {
        ...fixture.port.startThread,
        unavailableReason: 'This node does not expose chat thread configuration yet.',
      },
    };
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByRole('button', { name: /new chat/i })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    expect(view.getByText(/does not expose chat thread configuration/i)).toBeTruthy();
    expect(view.getByRole('button', { name: /send/i }).getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps an interrupted thread continuable with its persisted partial turn and usage', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        newMutationId={(prefix) => `${prefix}:interrupt-test`}
      />,
    );
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(view.getByTestId('tch-send-working')).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /stop/i }));

    await waitFor(() => expect(view.getByText('Stopped · continuable')).toBeTruthy());
    expect(view.getByText(/this thread is continuable/i)).toBeTruthy();
    expect((view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).disabled).toBe(false);
    expect(controls.interrupts).toEqual(['019f0000-0000-7000-8000-000000000010']);
    expect(view.getByText('I found the current context before the turn was stopped.')).toBeTruthy();
    expect(view.getAllByTestId('chat-usage-card')).toHaveLength(2);
    expect(view.getAllByTestId('chat-usage-card')[1]?.textContent).toContain('$0.0012');

    const stopped = await port.readThread(controls.interrupts[0]!);
    const interruptedTurn = stopped.turns.at(-1)!;
    expect(stopped.summary.state).toBe('stopped-continuable');
    expect(interruptedTurn.parts.at(-2)).toMatchObject({ kind: 'tool_result', isError: true });
    expect(interruptedTurn.parts.at(-1)).toMatchObject({ kind: 'done' });

    act(() => {
      controls.emit({
        type: 'chat.turn.done',
        chatId: stopped.summary.rootId,
        messageId: interruptedTurn.messageId,
        usage: {},
      });
    });
    expect(view.getByText('Stopped · continuable')).toBeTruthy();

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Continue from the persisted result.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.posts).toHaveLength(2));
    expect(controls.posts[1]).toMatchObject({
      chatId: stopped.summary.rootId,
      body: 'Continue from the persisted result.',
    });
    expect(view.getByTestId('tch-send-working')).toBeTruthy();
  });

  /**
   * The server writes the assistant message body TWICE: a placeholder when the
   * turn is claimed, then the final answer when it completes. Both are the
   * durable projection of the parts for feeds and notifications — the
   * transcript renders the parts, so printing the body here draws the answer
   * twice on every re-read and a redundant "Agent turn in progress." bubble
   * over the thinking pulse. The fixture used to model an assistant body as
   * `''`, which is why no test could see either.
   */
  it('never prints an assistant body the parts already say', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);

    await waitFor(() => expect(view.getAllByTestId('chat-ledger-reads')).toHaveLength(1));
    expect(
      view.getAllByText(/I mapped the work into three dependency-safe lanes/, {
        selector: '.tch-transcript *',
      }),
    ).toHaveLength(1);
  });

  it('shows the pulse alone while a claimed turn has produced nothing yet', async () => {
    const view = await sendInto(claimingPort(CHAT_HOME_FIXTURE_THREAD, [placeholderTurn()]));

    await waitFor(() => expect(view.getByTestId('chat-thinking')).toBeTruthy());
    expect(view.queryByText('Agent turn in progress.')).toBeNull();
  });

  /**
   * The composer stays open while a turn streams, so a later message can sit
   * AFTER the claimed placeholder. Keying the suppression to the last row put
   * it on the wrong turn and printed the placeholder again — the reported bug,
   * one ordering to the left.
   */
  it('covers the claimed turn even when a later message follows it', async () => {
    const view = await sendInto(
      claimingPort(CHAT_HOME_FIXTURE_THREAD, [
        placeholderTurn(),
        {
          messageId: '019f0000-0000-7000-8000-0000000000a1' as EntityId,
          role: 'user',
          author: CHAT_HOME_FIXTURE_THREAD.turns[0]!.author,
          createdAt: '2026-08-13T08:19:40.000Z',
          body: 'One more thing while you work.',
          parts: [],
        },
      ]),
    );

    await waitFor(() => expect(view.getByText('One more thing while you work.')).toBeTruthy());
    expect(view.getByTestId('chat-thinking')).toBeTruthy();
    expect(view.queryByText('Agent turn in progress.')).toBeNull();
  });

  /**
   * `role` is derived from `author.isAgent` alone, so a message a teammate
   * posts into the thread by the ordinary writer is assistant-role with no
   * parts. Arriving beside the placeholder does not make it one — only the
   * server's own claim sentence does.
   */
  it('never swallows a teammate message arriving beside the placeholder', async () => {
    const view = await sendInto(
      claimingPort(CHAT_HOME_FIXTURE_THREAD, [
        placeholderTurn(),
        {
          messageId: '019f0000-0000-7000-8000-0000000000a2' as EntityId,
          role: 'assistant',
          author: CHAT_HOME_FIXTURE_THREAD.turns[1]!.author,
          createdAt: '2026-08-13T08:19:45.000Z',
          body: 'Heads up: I am reading the storage lane first.',
          parts: [],
        },
      ]),
    );

    await waitFor(() =>
      expect(view.getByText('Heads up: I am reading the storage lane first.')).toBeTruthy(),
    );
    expect(view.queryByText('Agent turn in progress.')).toBeNull();
  });

  /**
   * The UI reaches `streaming` on its own post; the server writes the
   * placeholder only once it CLAIMS the turn. A teammate message landing in
   * that window — or one durable all along and first seen by this tab now,
   * since the screen never subscribes to ordinary message additions — is new
   * to the arrival snapshot without being our placeholder. Only the server's
   * claim sentence separates them.
   */
  it('never swallows a teammate message that arrives before the claim', async () => {
    const view = await sendInto(
      claimingPort(CHAT_HOME_FIXTURE_THREAD, [
        {
          messageId: '019f0000-0000-7000-8000-0000000000a5' as EntityId,
          role: 'assistant',
          author: CHAT_HOME_FIXTURE_THREAD.turns[1]!.author,
          createdAt: '2026-08-13T08:19:35.000Z',
          body: 'Heads up: I am reading the storage lane first.',
          parts: [],
        },
      ]),
    );

    await waitFor(() => expect(view.getByTestId('chat-thinking')).toBeTruthy());
    expect(view.getByText('Heads up: I am reading the storage lane first.')).toBeTruthy();
  });

  /**
   * Two claimed turns in one thread: both carry the sentinel, so neither can
   * be attributed to this pulse. A redundant progress line is a blemish; the
   * wrong turn covered is a lie about whose work is running.
   */
  it('covers neither placeholder when two turns are claimed at once', async () => {
    const view = await sendInto(
      claimingPort(CHAT_HOME_FIXTURE_THREAD, [
        placeholderTurn(),
        {
          ...placeholderTurn(),
          messageId: '019f0000-0000-7000-8000-0000000000a6' as EntityId,
          createdAt: '2026-08-13T08:19:50.000Z',
        },
      ]),
    );

    await waitFor(() => expect(view.getByTestId('chat-thinking')).toBeTruthy());
    expect(view.getAllByText('Agent turn in progress.')).toHaveLength(2);
  });

  /**
   * A thread can already hold a silent teammate message before the user types.
   * The UI reaches `streaming` on its own post, while the server writes the
   * placeholder only once it CLAIMS the turn — so in that window the only
   * silent assistant on screen is somebody's real message. Cardinality alone
   * suppressed it. Nothing that predates our post can be our placeholder.
   */
  it('never suppresses a message that was already there when we posted', async () => {
    const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    thread.turns = [
      thread.turns[0]!,
      {
        messageId: '019f0000-0000-7000-8000-0000000000a4' as EntityId,
        role: 'assistant',
        author: thread.turns[1]!.author,
        createdAt: '2026-08-13T08:19:10.000Z',
        body: 'Heads up: I am reading the storage lane first.',
        parts: [],
      },
    ];
    // Nothing claimed yet — exactly the window between our post and the
    // server's placeholder write.
    const view = await sendInto(claimingPort(thread, []));

    await waitFor(() => expect(view.getByTestId('chat-thinking')).toBeTruthy());
    expect(view.getByText('Heads up: I am reading the storage lane first.')).toBeTruthy();
  });

  /**
   * After a reload there is no post to measure arrival against, and thread
   * liveness is never read back from the server, so nothing identifies a
   * placeholder. The durable body is then the only hint that surface has, and
   * printing it is more honest than hiding an unidentified message.
   */
  it('keeps the durable body when a reload finds a claimed turn', async () => {
    const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    thread.summary.state = 'streaming';
    thread.turns = [thread.turns[0]!, placeholderTurn()];
    const { port } = createChatHomeFixturePort([thread]);
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);

    await waitFor(() => expect(view.getByText('Agent turn in progress.')).toBeTruthy());
  });

  /**
   * The same reload, on a server that projects the wire marker (migration
   * 133): `turnInFlight` identifies the claimed turn by the server's own
   * record, so the placeholder is suppressed and the pulse covers it even
   * with no arrival snapshot to lean on.
   */
  it('suppresses the placeholder on reload when the wire marker is present', async () => {
    const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    thread.summary.state = 'streaming';
    thread.turns = [thread.turns[0]!, { ...placeholderTurn(), turnInFlight: true }];
    const { port } = createChatHomeFixturePort([thread]);
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);

    await waitFor(() => expect(view.getByTestId('chat-thinking')).toBeTruthy());
    expect(view.queryByText('Agent turn in progress.')).toBeNull();
    // And the composer carries the running state as the send-button loader.
    expect(view.getByTestId('tch-send-working')).toBeTruthy();
  });

  /**
   * `projectTurnParts` drops `done`, so a turn that terminated without output
   * holds one stored part and DRAWS nothing. Suppressing its body on
   * `parts.length` left an empty bubble where the durable fallback belongs.
   */
  it('keeps the durable fallback when a turn stored parts but drew nothing', async () => {
    const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    thread.turns = [
      thread.turns[0]!,
      {
        messageId: '019f0000-0000-7000-8000-0000000000a3' as EntityId,
        role: 'assistant',
        author: thread.turns[1]!.author,
        createdAt: '2026-08-13T08:20:00.000Z',
        body: 'Agent turn completed.',
        parts: [{ seq: 0, kind: 'done' }],
      },
    ];
    const { port } = createChatHomeFixturePort([thread]);
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);

    await waitFor(() => expect(view.getByText('Agent turn completed.')).toBeTruthy());
  });

  it('says why a running turn cannot be stopped when the port has no interrupt', async () => {
    const fixture = createChatHomeFixturePort();
    const { interrupt: _interrupt, ...withoutInterrupt } = fixture.port;
    const view = render(
      <ChatHomeScreen port={withoutInterrupt} spaceId={SPACE_ID} models={MODELS} />,
    );
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    const working = await view.findByTestId('tch-send-working');
    expect(working.getAttribute('aria-disabled')).toBe('true');
    expect(working.getAttribute('title')).toMatch(/no chat interrupt operation is exposed/);
  });
});
