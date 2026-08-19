// @vitest-environment jsdom
/**
 * THE FOUR PHONE-CHAT DEFECTS REPORTED ON TASK 01a01c3f, one guard each.
 *
 * Each `it` below was written against the BROKEN tree first and seen to fail;
 * the note on each says which line it hinges on, so the next person can break
 * it again in one edit rather than trusting a green run.
 *
 * WHY ONE OF THEM READS A STYLESHEET INSTEAD OF THE DOM. The transcript's
 * scroll clipping is a pure CSS defect — one `justify-content` declaration —
 * and jsdom loads no stylesheets and lays nothing out, so `scrollHeight`,
 * `clientHeight` and every rect in this environment are 0. There is no DOM
 * assertion that can see it. Asserting the SOURCE is not a substitute for the
 * browser measurement (that lives in `.scratch/measure-chat-scroll.mjs`, which
 * put the number at 2607px of unreachable history before and -18px after); it
 * is the part that can run in CI, and it fails the moment the declaration
 * comes back.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption, ChatThreadDetail } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

/* FROM THE CWD, not from `import.meta.url`. Under vite that URL is an http
   one, and in the JSDOM environment resolving `'.'` against it lands on the
   document base rather than this directory — `chat-html-css-coverage.test.ts`
   gets away with the URL spelling only because it runs under `node`. Vitest
   runs with the package root as cwd. */
const SRC = `${process.cwd()}/src`;
const CSS = readFileSync(`${SRC}/chat-home/chat-home.css`, 'utf8');

/** The declaration block of the first rule whose selector matches `needle`. */
function ruleBody(needle: string): string {
  const at = CSS.indexOf(needle);
  expect(at, `no rule matching ${needle} in chat-home.css`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('the transcript can be scrolled back to the beginning', () => {
  /**
   * HINGES ON: `justify-content: center` in the phone's
   * `.tch-conversation .tch-transcript` rule. Put it back and this reds.
   *
   * `justify-content` distributes NEGATIVE free space as readily as positive,
   * so on an overflowing scroller it places half the overflow above
   * `scrollTop: 0` — where no gesture reaches it. The reporter's words: "the
   * chat is not going up after a point ... it should be scrollable till the
   * begining."
   */
  it('declares no justify-content on the phone transcript', () => {
    const body = ruleBody(".cv2-root[data-shell='mobile'] .tch-conversation .tch-transcript");
    expect(body).not.toMatch(/justify-content/);
  });

  /** The base rule is the scroller itself; if it ever stops being one, the
   *  rule above is guarding nothing and this says so. */
  it('keeps the transcript an overflow-y scroller', () => {
    expect(ruleBody('\n.tch-transcript {')).toMatch(/overflow-y:\s*auto/);
  });

  /**
   * The removal is only safe because `.tch-welcome` centres ITSELF — it is
   * `flex: 1` with `margin: auto`, so it fills the transcript and leaves
   * `justify-content` nothing to distribute. Drop either and the greeting
   * really would need the parent's centring back.
   */
  it('leaves the greeting centring on .tch-welcome, which owns it', () => {
    const body = ruleBody('\n.tch-welcome {');
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/margin:\s*auto/);
  });
});

describe('a conversation opens at its newest turn', () => {
  /*
   * jsdom has no layout: `scrollHeight`/`clientHeight` are 0 and the
   * `scrollTop` setter clamps to that, so a real assertion is impossible
   * without giving the environment the two numbers it lacks. These stand in
   * for a laid-out box and record every write, which is exactly the fact under
   * test — WHETHER the screen scrolls, not by how much.
   */
  const CONTENT = 4000;
  const VIEWPORT = 800;
  let writes: number[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    writes = [];
    for (const name of ['scrollHeight', 'clientHeight', 'scrollTop']) {
      saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    }
    const positions = new WeakMap<HTMLElement, number>();
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('tch-transcript') ? CONTENT : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('tch-transcript') ? VIEWPORT : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return positions.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        positions.set(this, value);
        if (this.classList.contains('tch-transcript')) writes.push(value);
      },
    });
  });

  afterEach(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  });

  /**
   * HINGES ON: the `useLayoutEffect` keyed `[detail, thinking]` that assigns
   * `element.scrollTop = element.scrollHeight`. Delete it and this reds —
   * which is what the tree did before this task: there was no scroll code on
   * this screen at all, and every conversation opened on its OLDEST message.
   */
  it('scrolls the transcript to the end once the thread has loaded', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes.at(-1)).toBe(CONTENT);
  });

  /**
   * HINGES ON: the `onScroll` handler that records the reader's intent, and on
   * the effect honouring it. A reader who scrolled up to read back must not be
   * yanked to the bottom by a turn arriving underneath them.
   */
  it('stops following once the reader scrolls up, and follows again at the end', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));

    const transcript = view.container.querySelector('.tch-transcript') as HTMLElement;

    // Read back: far from the end, so following is off.
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    writes.length = 0;
    await act(async () => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: CHAT_HOME_FIXTURE_THREAD.summary.rootId,
        messageId: CHAT_HOME_FIXTURE_THREAD.turns[1]!.messageId,
        seq: 900,
        text: ' and more.',
      });
    });
    expect(writes).toEqual([]);

    // Back within the tolerance of the end: following resumes with no control
    // to find and press.
    transcript.scrollTop = CONTENT - VIEWPORT - 4;
    fireEvent.scroll(transcript);
    writes.length = 0;
    await act(async () => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: CHAT_HOME_FIXTURE_THREAD.summary.rootId,
        messageId: CHAT_HOME_FIXTURE_THREAD.turns[1]!.messageId,
        seq: 901,
        text: ' and more still.',
      });
    });
    expect(writes.at(-1)).toBe(CONTENT);
  });
});

describe('the screen tells a solo host what it actually selected', () => {
  /**
   * HINGES ON: nothing in this file — this is the SEAM the phone's "New
   * conversation" fix stands on, pinned so it cannot be quietly dropped.
   *
   * `MobileShell` pushes a selection down through `routeThreadId` and, before
   * this task, never heard back. Cold start auto-opens the most recent
   * conversation, so the shell held `null` while a real thread was on screen —
   * and `setThreadId(null)` from `null` is not a change, so the drawer's "New
   * conversation" re-rendered nothing and the open thread stayed open.
   */
  it('publishes the cold-start auto-open', async () => {
    const { port } = createChatHomeFixturePort();
    const seen: (EntityId | null)[] = [];
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        soloConversation
        routeThreadId={null}
        onSelectionChange={(id) => seen.push(id)}
      />,
    );
    await waitFor(() => expect(view.getByText(/Plan the launch sequence/)).toBeTruthy());
    expect(seen.at(-1)).toBe(CHAT_HOME_FIXTURE_THREAD.summary.rootId);
  });
});

describe('the waits are drawn when there is something to wait for', () => {
  /**
   * HINGES ON: the `loading || startingThread` arm in the transcript.
   *
   * The greeting says "New conversation" — a claim about the space. During the
   * opening `listThreads` read nobody has established it, and cold start then
   * auto-opens a conversation that existed the whole time. On a solo host the
   * sidebar's own "Reading conversations…" line is not even mounted, so this
   * read had NO loading state at all.
   */
  it('waits rather than greeting while the conversation list is being read', async () => {
    let release = (_: readonly never[]) => {};
    const { port: base } = createChatHomeFixturePort();
    const port: ChatHomePort = {
      ...base,
      listThreads: () => new Promise((resolve) => { release = resolve as typeof release; }),
    };
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} soloConversation />,
    );
    expect(view.getByTestId('chat-home-loading').textContent).toContain('Reading your conversations');
    expect(view.queryByText(/New conversation — pick a mode/)).toBeNull();

    await act(async () => { release([]); });
    // An empty space really IS a new conversation — the greeting is honest now.
    await waitFor(() => expect(view.getByText(/New conversation — pick a mode/)).toBeTruthy());
  });

  /**
   * HINGES ON: the same arm, via `startingThread`.
   *
   * `thinking` is gated on `detail !== null` — it has to be, `showThinking`
   * reads the turns — and a thread being BORN has no detail. So the two round
   * trips a first message costs (`posting-root`, `configuring`) drew the
   * greeting, on the one screen state where pressing Send is the whole point.
   */
  it('waits while a brand-new thread is being created', async () => {
    const { port: base } = createChatHomeFixturePort([]);
    let release = () => {};
    const port: ChatHomePort = {
      ...base,
      startThread: {
        ...base.startThread,
        createRoot: (input) =>
          new Promise((resolve) => {
            release = () => resolve(base.startThread.createRoot(input) as never);
          }) as ReturnType<ChatHomePort['startThread']['createRoot']>,
      },
    };
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} soloConversation />,
    );
    await waitFor(() => expect(view.getByText(/New conversation — pick a mode/)).toBeTruthy());

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Start something.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(view.getByTestId('chat-home-loading').textContent).toContain('Starting this conversation'),
    );
    expect(view.queryByText(/New conversation — pick a mode/)).toBeNull();
    await act(async () => { release(); });
  });
});

describe('the phone shell mirrors the selection it was never told about', () => {
  /**
   * HINGES ON: `onSelectionChange: setThreadId` in `MobileShell`'s
   * `screenFor(...)` call. This asserts the WIRING rather than re-testing the
   * screen: `MobileShell` needs a whole seam to render, and the fact that
   * matters is a single prop being passed at all.
   */
  it('passes onSelectionChange into the chat screen', () => {
    const shell = readFileSync(`${SRC}/views/MobileShell.tsx`, 'utf8');
    expect(shell).toMatch(/onSelectionChange:\s*setThreadId/);
    expect(shell).toMatch(/onSelectionChange=\{chat\.onSelectionChange\}/);
  });
});
