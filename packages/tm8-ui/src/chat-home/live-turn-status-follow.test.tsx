// @vitest-environment jsdom
/**
 * A READER AT THE END STAYS THERE; A READER WHO LEFT IS NEVER MOVED — AND IS
 * TOLD THE WAY BACK.
 *
 * The first two halves predate this lane and stay pinned where they were
 * (`phone-chat-defects.test.tsx`, `phone-chat-open.test.tsx`). This file pins
 * the half that was missing: a reader who scrolled up during a long turn had no
 * sign anything was arriving below them and no way back but dragging the whole
 * thread. Now they get `↓ Jump to latest · N new` (advisor D5 / D16.4).
 *
 * jsdom lays nothing out, so — exactly as those two files do — the transcript's
 * `scrollHeight` / `clientHeight` are stubbed and every `scrollTop` write is
 * recorded. The fact under test is WHETHER the screen scrolls, not by how much.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import { JUMP_SETTLE_MS, NEAR_BOTTOM_PX } from './live-turn-status-follow';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const ROOT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
const EXISTING_AGENT_TURN = CHAT_HOME_FIXTURE_THREAD.turns[1]!.messageId;

const VIEWPORT = 800;
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
    /* A `hidden` (display:none) box has no layout and measures 0 — which is
       exactly the reading the stage bug was built on. */
    get(this: HTMLElement) {
      return this.classList.contains('tch-transcript') && !this.hidden ? contentHeight : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('tch-transcript') && !this.hidden ? VIEWPORT : 0;
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
  vi.unstubAllGlobals();
});

async function mounted() {
  const { port, controls } = createChatHomeFixturePort();
  const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
  await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
  await waitFor(() => expect(writes.length).toBeGreaterThan(0));
  const transcript = view.container.querySelector('.tch-transcript') as HTMLElement;
  return { view, controls, transcript };
}

function readBack(transcript: HTMLElement) {
  transcript.scrollTop = 0;
  fireEvent.scroll(transcript);
  writes.length = 0;
}

let seq = 900;
/** A step for the turn already on screen — the conversation grows, but no
 *  new MESSAGE arrives. */
function stepOnExistingTurn(controls: ReturnType<typeof createChatHomeFixturePort>['controls']) {
  contentHeight += 120;
  controls.emit({
    type: 'chat.turn.delta',
    chatId: ROOT,
    messageId: EXISTING_AGENT_TURN,
    seq: (seq += 1),
    part: { kind: 'text', text: ' and one more paragraph.' },
  });
}
/** A new agent message — what `N new` counts. */
function newMessage(controls: ReturnType<typeof createChatHomeFixturePort>['controls'], id: string) {
  contentHeight += 200;
  controls.emit({
    type: 'chat.turn.delta',
    chatId: ROOT,
    messageId: id as EntityId,
    seq: 0,
    part: { kind: 'text', text: 'A new reply.' },
  });
}

const pill = (view: ReturnType<typeof render>) => view.queryByTestId('chat-jump-latest');

describe('the way back to the end', () => {
  it('is not offered to a reader who is at the end', async () => {
    const { view, controls } = await mounted();
    await act(async () => stepOnExistingTurn(controls));
    expect(pill(view)).toBeNull();
    expect(writes.at(-1)).toBe(contentHeight); // and they were followed
  });

  /**
   * HINGES ON: `onScroll` recording `leftAt` in `useTranscriptFollow`. Make it
   * record nothing and `away` never becomes true — the pill never renders.
   */
  it('is offered the moment the reader leaves the end, and they are not moved', async () => {
    const { view, controls, transcript } = await mounted();
    readBack(transcript);
    expect(pill(view)?.textContent).toBe('↓ Jump to latest');
    await act(async () => stepOnExistingTurn(controls));
    expect(writes).toEqual([]);
  });

  /** D16.4: steps land every few seconds; a number that climbs by itself
   *  reads as a notification. Only MESSAGES count. */
  it('counts new messages, not steps', async () => {
    const { view, controls, transcript } = await mounted();
    readBack(transcript);
    await act(async () => stepOnExistingTurn(controls));
    await act(async () => stepOnExistingTurn(controls));
    expect(pill(view)?.textContent).toBe('↓ Jump to latest');
    await act(async () => newMessage(controls, '019f0000-0000-7000-8003-000000000001'));
    await waitFor(() => expect(pill(view)?.textContent).toBe('↓ Jump to latest · 1 new'));
    expect(writes).toEqual([]);
  });

  it('while a turn runs, sits in the live row’s card rather than on its own', async () => {
    const { view, controls, transcript } = await mounted();
    readBack(transcript);
    await act(async () => newMessage(controls, '019f0000-0000-7000-8003-000000000002'));
    const dock = await view.findByTestId('chat-dock');
    await waitFor(() => expect(dock.dataset.live).toBe('true'));
    expect(pill(view)?.parentElement).toBe(dock);
  });

  /**
   * HINGES ON: `jumpToLatest` — scroll to the end, re-pin, drop `leftAt`, and
   * keep focus in the transcript (the pressed pill unmounts with `away`).
   */
  it('Jump scrolls to the end, re-pins, disappears, and keeps focus in the transcript', async () => {
    const { view, controls, transcript } = await mounted();
    readBack(transcript);
    await act(async () => newMessage(controls, '019f0000-0000-7000-8003-000000000003'));
    const button = await waitFor(() => {
      const found = pill(view);
      expect(found).not.toBeNull();
      return found!;
    });
    button.focus();
    fireEvent.click(button);
    expect(writes.at(-1)).toBe(contentHeight);
    expect(pill(view)).toBeNull();
    expect(document.activeElement).toBe(transcript);

    // Re-pinned: the next growth is followed again.
    writes.length = 0;
    await act(async () => stepOnExistingTurn(controls));
    expect(writes.at(-1)).toBe(contentHeight);
  });

  it('also disappears when the reader scrolls back to the end themselves', async () => {
    const { view, transcript } = await mounted();
    readBack(transcript);
    expect(pill(view)).not.toBeNull();
    transcript.scrollTop = contentHeight - VIEWPORT - (NEAR_BOTTOM_PX - 1);
    fireEvent.scroll(transcript);
    expect(pill(view)).toBeNull();
  });

  /** D5: 40px — pinned means within 40px of the bottom, not 48 as before. */
  it('treats 40px from the end as the end, and 41px as away', async () => {
    const { view, transcript } = await mounted();
    transcript.scrollTop = contentHeight - VIEWPORT - 41;
    fireEvent.scroll(transcript);
    expect(pill(view)).not.toBeNull();
    transcript.scrollTop = contentHeight - VIEWPORT - 40;
    fireEvent.scroll(transcript);
    expect(pill(view)).toBeNull();
  });
});

/**
 * L5's finding, measured on :7777: back from the Graph stage the transcript sat
 * at scrollTop 344 of 757 — mid-thread, not at the newest turn. A stage hides
 * the transcript (display:none), a hidden box measures 0, and the follow
 * effect recorded that 0 as "followed" and never re-ran on the way back.
 */
describe('coming back from a stage (or any host panel)', () => {
  async function withStage() {
    const { port, controls } = createChatHomeFixturePort();
    const props = { port, spaceId: SPACE_ID, models: MODELS };
    const view = render(<ChatHomeScreen {...props} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const transcript = view.container.querySelector('.tch-transcript') as HTMLElement;
    const openStage = () => view.rerender(<ChatHomeScreen {...props} centerOverride={<div data-testid="stage" />} />);
    const closeStage = () => view.rerender(<ChatHomeScreen {...props} />);
    return { view, controls, transcript, openStage, closeStage };
  }

  /** HINGES ON: `visible` in the follow effect's keys (the re-anchor on the
   *  way back) and the `!visible` guard (no write into a hidden box). */
  it('a reader who was at the end lands on the newest turn, even if it grew meanwhile', async () => {
    const { controls, transcript, openStage, closeStage } = await withStage();
    writes.length = 0;
    openStage();
    expect(transcript.hidden).toBe(true);
    await act(async () => stepOnExistingTurn(controls)); // the turn grows behind the stage
    // Nothing is written into a hidden box — its 0 is not a height to follow.
    expect(writes).toEqual([]);
    closeStage();
    expect(writes.at(-1)).toBe(contentHeight);
  });

  it('a reader who had scrolled up gets their place back, and the way back is still offered', async () => {
    const { view, transcript, openStage, closeStage } = await withStage();
    transcript.scrollTop = 1000;
    fireEvent.scroll(transcript);
    expect(pill(view)).not.toBeNull();
    openStage();
    transcript.scrollTop = 0; // what display:none does to a real box's position
    writes.length = 0;
    closeStage();
    expect(writes.at(-1)).toBe(1000);
    expect(pill(view)).not.toBeNull();
  });
});

describe('Jump respects motion preferences (D5)', () => {
  function motion(reduced: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('no-preference') ? !reduced : reduced,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    }));
  }

  it('scrolls smoothly when motion is allowed, and its own travel does not re-arm the pill', async () => {
    motion(false);
    const { view, transcript } = await mounted();
    const scrollTo = vi.fn();
    transcript.scrollTo = scrollTo as unknown as typeof transcript.scrollTo;
    readBack(transcript);
    fireEvent.click(pill(view)!);
    expect(scrollTo).toHaveBeenCalledWith({ top: contentHeight, behavior: 'smooth' });
    // A frame of the smooth scroll, still far from the end: not the reader leaving.
    transcript.scrollTop = contentHeight / 2;
    fireEvent.scroll(transcript);
    expect(pill(view)).toBeNull();
  });

  /**
   * HINGES ON: the finisher `jumpToLatest` arms. A smooth scroll is not
   * guaranteed to arrive — in a hidden Chrome tab it never moves (no animation
   * frames) — and without the finisher the reader was left 634px short of the
   * end with the pill gone. `scrollTo` here is a stub that goes nowhere, which
   * is exactly that tab.
   */
  it('finishes a smooth jump that never arrived', async () => {
    motion(false);
    const { view, transcript } = await mounted();
    transcript.scrollTo = vi.fn() as unknown as typeof transcript.scrollTo;
    readBack(transcript);
    fireEvent.click(pill(view)!);
    expect(writes).toEqual([]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, JUMP_SETTLE_MS + 100));
    });
    expect(writes.at(-1)).toBe(contentHeight);
  });

  it('a reader who scrolls back up mid-jump is honoured, not snapped', async () => {
    motion(false);
    const { view, transcript } = await mounted();
    transcript.scrollTo = vi.fn() as unknown as typeof transcript.scrollTo;
    transcript.scrollTop = 1000;
    fireEvent.scroll(transcript);
    writes.length = 0;
    fireEvent.click(pill(view)!);
    // The jump's own travel toward the end is excused…
    transcript.scrollTop = 1500;
    fireEvent.scroll(transcript);
    expect(pill(view)).toBeNull();
    // …the reader pulling back up is not.
    transcript.scrollTop = 200;
    fireEvent.scroll(transcript);
    expect(pill(view)).not.toBeNull();
    writes.length = 0;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, JUMP_SETTLE_MS + 100));
    });
    expect(writes).toEqual([]);
  });

  it('jumps instantly under reduced motion', async () => {
    motion(true);
    const { view, transcript } = await mounted();
    const scrollTo = vi.fn();
    transcript.scrollTo = scrollTo as unknown as typeof transcript.scrollTo;
    readBack(transcript);
    fireEvent.click(pill(view)!);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(writes.at(-1)).toBe(contentHeight);
  });
});
