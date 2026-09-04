// @vitest-environment jsdom
/**
 * OPENING A CONVERSATION ON THE PHONE — the three mechanisms behind "loading a
 * chat flickers the entire page" (reported by Subhang), one guard each.
 *
 * Each case below was measured against the UNFIXED tree first and the number it
 * asserts is the number that tree produced, so these fail for the right reason
 * rather than passing by construction. The measurements are recorded on the
 * task and repeated in each docblock, because a threshold whose provenance is
 * lost is a threshold the next person has to re-derive before they dare move
 * it.
 *
 * WHY A NEW FILE AND NOT `phone-chat-defects.test.tsx`. That file is the four
 * defects of task 01a01c3f and says so in its header; these are a different
 * report. It is also being edited by three sibling lanes at the same time as
 * this one, and a new file is the version of "rebase rather than reformat"
 * available to a test author.
 *
 * ── THE PART THAT CANNOT RUN HERE ─────────────────────────────────────────
 *
 * jsdom lays nothing out: every `scrollHeight`, `clientHeight` and rect is 0,
 * and the `scrollTop` setter clamps to that. The scroll cases below install the
 * same stubbed metrics `phone-chat-defects.test.tsx` uses — they stand in for a
 * laid-out box and record every write, which is exactly the fact under test:
 * WHETHER the screen scrolls, not by how much.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { Profiler, useState, type ProfilerOnRenderCallback } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption, ChatThreadDetail } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const FIRST_ROOT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
/** The body of the thread the reader is LEAVING — the string that must not
 *  survive into the incoming thread's selection. */
const FIRST_BODY = /Plan the launch sequence and check/;

const SECOND_ROOT = '019f0000-0000-7000-8000-000000000050' as EntityId;
const SECOND_BODY = 'A different conversation entirely.';
/** A second thread, OLDER than the fixture's so `listThreads` (most-recent
 *  first) still auto-opens the fixture one and this is the thread switched TO. */
const SECOND_THREAD: ChatThreadDetail = {
  summary: {
    ...CHAT_HOME_FIXTURE_THREAD.summary,
    rootId: SECOND_ROOT,
    title: 'The second conversation',
    preview: 'Something else.',
    updatedAt: '2026-08-12T08:20:00.000Z',
    replyCount: 4,
  },
  turns: [
    {
      ...CHAT_HOME_FIXTURE_THREAD.turns[0]!,
      messageId: '019f0000-0000-7000-8000-000000000051' as EntityId,
      body: SECOND_BODY,
    },
  ],
};

/**
 * A port whose read of the SECOND thread can be held open, so the state between
 * the tap and the turns arriving — the state this whole task is about — can be
 * inspected instead of raced past.
 */
function heldSecondRead(): { port: ChatHomePort; release: () => void } {
  const { port: base } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD, SECOND_THREAD]);
  let release = () => {};
  return {
    port: {
      ...base,
      readThread: async (rootId) => {
        if (rootId === SECOND_ROOT) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return base.readThread(rootId);
      },
    },
    release: () => release(),
  };
}

/**
 * THE PHONE SHELL'S SELECTION STATE, and nothing else of it.
 *
 * `MobileShell` holds the chosen thread in `useState` and hands it down as
 * `routeThreadId` while taking the screen's resolved answer back through
 * `onSelectionChange` — the loop its `threadId` docblock exists to establish.
 * `pick()` is the drawer's `onSelectThread`; `selected` is what the drawer
 * reads as `selectedThreadId`, from which its rows compute
 * `aria-current={thread.rootId === props.selectedThreadId}`.
 *
 * The wiring itself is pinned at the source in `phone-chat-defects.test.tsx`;
 * what is modelled here is the BEHAVIOUR of the loop, which needs no drawer.
 */
function mountHosted(port: ChatHomePort) {
  const state = {
    renders: 0,
    selected: null as EntityId | null,
    /** The transcript's text as of EVERY commit, not merely as of the moment a
     *  test happens to look. `Profiler`'s `onRender` runs in the commit phase
     *  with the DOM already mutated, so this catches frames that exist for one
     *  paint and are gone before any `waitFor` could see them — which is the
     *  only granularity at which "it flickered" is a testable claim. */
    frames: [] as string[],
  };
  let pick: (id: EntityId | null) => void = () => {};

  const onRender: ProfilerOnRenderCallback = () => {
    state.frames.push(document.querySelector('.tch-transcript')?.textContent ?? '');
  };

  function Host() {
    const [threadId, setThreadId] = useState<EntityId | null>(null);
    state.renders += 1;
    state.selected = threadId;
    pick = setThreadId;
    return (
      <Profiler id="chat-home" onRender={onRender}>
        <ChatHomeScreen
          port={port}
          spaceId={SPACE_ID}
          models={MODELS}
          soloConversation
          routeThreadId={threadId}
          onSelectionChange={setThreadId}
        />
      </Profiler>
    );
  }

  return { view: render(<Host />), state, pick: (id: EntityId | null) => pick(id) };
}

describe('opening a conversation does not blank the page', () => {
  /**
   * HINGES ON: the `ThreadOpening` arm in the transcript. Put back the single
   * `.tch-wait--solo` row it replaced and this reds.
   *
   * MEASURED BEFORE: switching threads left the transcript holding one centred
   * wait row and nothing else. On a desktop that is one column of three; at
   * 390px it is the entire page, which is why the report is "the whole page
   * flickers" and not "the transcript flickers".
   */
  it('holds a shaped page while the incoming thread is read, not a bare wait mark', async () => {
    const { port, release } = heldSecondRead();
    const { view, pick } = mountHosted(port);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());

    await act(async () => {
      pick(SECOND_ROOT);
    });

    const opening = view.getByTestId('chat-detail-loading');
    /* The wait is still announced — same testid, same role, same words. What
       changed is that it is no longer ALONE. */
    expect(opening.textContent).toContain('Reading this conversation');
    /* The shape: placeholder turns standing where the real ones will stand, so
       the surface does not collapse and then refill from the top. */
    expect(opening.querySelectorAll('.tch-opening__row').length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      release();
    });
    await waitFor(() => expect(view.getByText(SECOND_BODY)).toBeTruthy());
  });

  /**
   * The skeleton traces the thread it is standing in for, so the arriving turns
   * do not re-lay the page they land on: the row count follows the summary's
   * `replyCount` — capped, because a hundred-reply thread must not paint a
   * hundred placeholder rows.
   */
  it('counts its placeholder turns from the incoming thread, capped at six', async () => {
    const { port, release } = heldSecondRead();
    const { view, pick } = mountHosted(port);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());

    await act(async () => {
      pick(SECOND_ROOT);
    });

    // SECOND_THREAD's summary says four replies, which is under the cap.
    expect(view.getByTestId('chat-detail-loading').querySelectorAll('.tch-opening__row')).toHaveLength(4);

    await act(async () => {
      release();
    });
    await waitFor(() => expect(view.getByText(SECOND_BODY)).toBeTruthy());
  });

  /**
   * THE INVARIANT THE OLD COMMENT WAS RIGHT ABOUT, restated as a test.
   *
   * The fix must not be "leave the outgoing transcript up": a reader who taps a
   * thread and reads the reply sitting there has been told something false, and
   * dimming it does not un-tell it. So while the incoming thread is being read,
   * nothing of the outgoing one is on the page — which the skeleton makes
   * trivially true, since it is built from the incoming summary alone.
   */
  it('never leaves one thread’s turns under another thread’s selection', async () => {
    const { port, release } = heldSecondRead();
    const { view, state, pick } = mountHosted(port);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());

    await act(async () => {
      pick(SECOND_ROOT);
    });

    expect(state.selected).toBe(SECOND_ROOT);
    expect(view.queryByText(FIRST_BODY)).toBeNull();
    expect(view.container.querySelector('.tch-transcript')?.textContent).not.toContain(
      'I mapped the work into three dependency-safe lanes',
    );

    await act(async () => {
      release();
    });
    await waitFor(() => expect(view.getByText(SECOND_BODY)).toBeTruthy());
  });
});

describe('picking a thread costs one pass, not two', () => {
  /**
   * HINGES ON: the render-phase adoption of `routeThreadId`. Move it back into
   * a `useEffect` and this reds.
   *
   * THIS IS THE STRONG FORM OF THE INVARIANT ABOVE, and the one that needed the
   * fix. An effect runs AFTER a commit, so an effect-borne adoption paints once
   * with the incoming `routeThreadId` and the OUTGOING `selectedRootId` — a
   * whole frame of the previous conversation, drawn while the drawer's ✓ has
   * already moved to the new row — and then paints again when the effect lands.
   * `waitFor` cannot see that frame; it is gone by the time anything settles.
   * `Profiler` can, because it runs per commit with the DOM already written.
   *
   * MEASURED: 5 commits for one tap before, 3 after — the adopt pass and the
   * publish echo below. The count itself is not asserted, deliberately: three
   * sibling lanes are editing this screen and a bare number would red on any of
   * their changes while saying nothing about this one. What is asserted is the
   * fact the count was standing in for.
   */
  it('never paints a frame of the outgoing thread under the incoming selection', async () => {
    const { port, release } = heldSecondRead();
    const { view, state, pick } = mountHosted(port);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());
    await act(async () => {});

    state.frames = [];
    await act(async () => {
      pick(SECOND_ROOT);
    });

    expect(state.frames.length).toBeGreaterThan(0);
    for (const frame of state.frames) {
      expect(frame).not.toContain('Plan the launch sequence and check');
      expect(frame).not.toContain('I mapped the work into three dependency-safe lanes');
    }

    await act(async () => {
      release();
    });
    await waitFor(() => expect(view.getByText(SECOND_BODY)).toBeTruthy());
  });

  /**
   * THE HOST IS NOT RE-RENDERED BY THE ANSWER IT ALREADY KNOWS.
   *
   * The screen publishes its resolved selection back through
   * `onSelectionChange` — the feedback loop `MobileShell`'s `threadId` docblock
   * establishes, and the reason its "New conversation" verb works at all. A
   * publish that MATCHES what the host pushed must not rebuild the shell.
   *
   * THE PROVENANCE OF THIS ONE IS WORTH BEING EXACT ABOUT, because it does not
   * red on the unfixed tree and a reader could otherwise think it guards the
   * original defect. Measured across the three states: 1 pass before any change
   * here, 2 after the adopt pass was cut, 1 again with the echo guard.
   *
   * The middle number is the finding. `MobileShell`'s docblock reasons that the
   * echo is free because `setThreadId(B)` from `B` sets no state, and that held
   * only by luck: React's eager bailout needs the host's fiber to be IDLE, and
   * it was — five commits into a tap. Cutting the adopt pass moved the publish
   * into the flush right after the tap, where the fiber is not idle, and the
   * free echo started costing a full rebuild of the screen tree. So this case
   * does not guard the reported defect; it guards the fix from paying for
   * itself, which is a thing a test should say out loud rather than imply.
   *
   * Asserted as one render rather than "no extra render" so the loop staying
   * closed is asserted too: `state.selected` below is what the drawer reads for
   * its `aria-current`, and it is the thread that was actually tapped.
   */
  it('costs the shell one render pass, with the highlight on the real selection', async () => {
    const { port, release } = heldSecondRead();
    const { view, state, pick } = mountHosted(port);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());
    await act(async () => {});
    expect(state.selected).toBe(FIRST_ROOT);

    state.renders = 0;
    await act(async () => {
      pick(SECOND_ROOT);
    });
    expect(state.renders).toBe(1);
    expect(state.selected).toBe(SECOND_ROOT);

    await act(async () => {
      release();
    });
    await waitFor(() => expect(view.getByText(SECOND_BODY)).toBeTruthy());
  });
});

describe('the transcript follows the bottom without becoming a scroll source', () => {
  /**
   * The stubbed metrics of `phone-chat-defects.test.tsx`, with ONE difference
   * that is the whole point of this block: the transcript's `scrollHeight` is a
   * VARIABLE THE TEST SETS rather than a constant.
   *
   * It has to be. The fact under test is whether the screen scrolls when the
   * content did not grow, and a pinned height cannot express "and now it did" —
   * while deriving it from the rendered text cannot express "and now it did
   * NOT", because in jsdom a streamed part leaves chrome on the page even when
   * its text is empty. Owning the number is the only spelling that can state
   * both halves, and it makes each case say in one line which one it is.
   */
  const VIEWPORT = 800;
  /** Well past `VIEWPORT`, so the box is always an overflowing scroller. */
  const BASE = 4000;
  let contentHeight = BASE;
  let writes: number[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    writes = [];
    contentHeight = BASE;
    for (const name of ['scrollHeight', 'clientHeight', 'scrollTop']) {
      saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    }
    const positions = new WeakMap<HTMLElement, number>();
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('tch-transcript') ? contentHeight : 0;
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

  const transcriptOf = (view: ReturnType<typeof render>) =>
    view.container.querySelector('.tch-transcript') as HTMLElement;

  /**
   * HINGES ON: the `followedHeightRef` guard in the stick-to-bottom layout
   * effect. Drop it and this reds with 10.
   *
   * MEASURED BEFORE: ten stream frames at an unchanged height cost ten scroll
   * writes. Every frame merge mints a new `detail` object, and the effect took
   * that as evidence of growth — but a delta that lands inside a line which has
   * not wrapped yet moves nothing.
   *
   * WHY IT IS WORTH A GUARD RATHER THAN A SHRUG. `MobileFrame` publishes
   * `--mobile-keyboard-inset` from `useKeyboardInset`, which recomputes on
   * visualViewport `resize` AND `scroll` and resizes the whole frame — so a
   * scroll nobody asked for is an input to a measurement whose output is a
   * layout change. On iOS that closed loop is the jitter.
   */
  it('does not scroll for frames that did not grow the content', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));

    writes.length = 0;
    for (let seq = 900; seq < 910; seq += 1) {
      await act(async () => {
        /* Ten frames, and `contentHeight` is not touched between them: each one
           mints a new `detail` object and costs a commit, and none of them moves
           the bottom. That is the shape of a stream appending inside a line that
           has not wrapped yet, which is most of a stream. */
        controls.emit({
          type: 'chat.turn.delta',
          chatId: FIRST_ROOT,
          messageId: CHAT_HOME_FIXTURE_THREAD.turns[1]!.messageId,
          seq,
          text: ` tok${seq}`,
        });
      });
    }
    expect(writes).toEqual([]);
  });

  /** The other half, so the guard cannot be satisfied by never scrolling: a
   *  frame that DOES add text still follows the bottom down. */
  it('still follows the bottom when the content does grow', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));

    writes.length = 0;
    contentHeight = BASE + 240; // the answer wrapped onto new lines
    await act(async () => {
      controls.emit({
        type: 'chat.turn.delta',
        chatId: FIRST_ROOT,
        messageId: CHAT_HOME_FIXTURE_THREAD.turns[1]!.messageId,
        seq: 920,
        text: ' one more sentence that lengthens the transcript.',
      });
    });
    expect(writes).toEqual([BASE + 240]);
    expect(transcriptOf(view)).toBeTruthy();
  });

  /**
   * THE READER'S INTENT STILL WINS, IN BOTH DIRECTIONS — and the second
   * direction is the one the guard could have broken.
   *
   * While they are reading back the followed height is DROPPED rather than
   * remembered, so the moment they come back within `NEAR_BOTTOM_PX` the next
   * frame re-anchors them even though the height never moved. Remembering it
   * would have made opting back in silently do nothing, which is the subtler
   * regression of the two and the reason this case exists.
   */
  it('re-anchors a reader who returns to the end, even at an unchanged height', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const transcript = transcriptOf(view);

    // Reading back: far from the end, so following is off. The turn arriving
    // underneath them grows the page and STILL must not move them.
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    writes.length = 0;
    contentHeight = BASE + 120;
    await act(async () => {
      controls.emit({
        type: 'chat.turn.delta',
        chatId: FIRST_ROOT,
        messageId: CHAT_HOME_FIXTURE_THREAD.turns[1]!.messageId,
        seq: 930,
        text: ' arriving underneath them.',
      });
    });
    expect(writes).toEqual([]);

    // Back within the tolerance, and NOTHING grows after that. They are still
    // re-anchored, with no control to find and press — which is the half a
    // naive "remember the last height" guard would have broken.
    transcript.scrollTop = contentHeight - VIEWPORT - 4;
    fireEvent.scroll(transcript);
    writes.length = 0;
    await act(async () => {
      controls.emit({
        type: 'chat.turn.delta',
        chatId: FIRST_ROOT,
        messageId: CHAT_HOME_FIXTURE_THREAD.turns[1]!.messageId,
        seq: 931,
        text: ' and one more.',
      });
    });
    expect(writes.at(-1)).toBe(contentHeight);
  });

  /** Opening a conversation is not growth, and it is not a continuation of the
   *  last one either: the incoming thread lands on its newest turn even if its
   *  height happens to match the one being left. */
  it('lands on the newest turn of a thread it switches to', async () => {
    const { port, release } = heldSecondRead();
    const { view, pick } = mountHosted(port);
    await waitFor(() => expect(view.getByText(FIRST_BODY)).toBeTruthy());
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));

    writes.length = 0;
    await act(async () => {
      pick(SECOND_ROOT);
    });
    await act(async () => {
      release();
    });
    await waitFor(() => expect(view.getByText(SECOND_BODY)).toBeTruthy());
    /* The incoming thread is a shorter one that happens to land on the SAME
       height the outgoing one had — the case a height guard alone would read as
       "already there" and leave the reader at the top of a thread they opened
       for its newest turn. */
    expect(writes.at(-1)).toBe(contentHeight);
    expect(transcriptOf(view)).toBeTruthy();
  });
});
