// @vitest-environment jsdom
/**
 * ── THE MOBILE CHAT FLICKER, PINNED AT ITS SOURCE ───────────────────────────
 *
 * Reported by Subhang: "the chat in mobile view is very buggy and flickering".
 *
 * The subscribe handler's `setThreads` updater ran `current.map(...)` on EVERY
 * frame — and `map` allocates a new array unconditionally, so `threads` took a
 * new identity at streaming TOKEN RATE even when no row's rendered facts had
 * moved. That identity fires the screen's publish effect, and a solo host wires
 * `onThreadsChange` to its OWN `setThreads`: on the phone (`MobileShell`, the
 * `dashboard` arm) that re-rendered the shell per token, rebuilding the header,
 * the frame, the drawer and the chat screen. The same block also stamped
 * `updatedAt` — the SORT KEY `composeThreadColumn` buckets and orders by — so
 * rows physically reordered underneath a reader mid-answer.
 *
 * These tests own the two invariants that fix depends on, and they assert them
 * where the defect was VISIBLE (publishes to the host, row order on screen)
 * rather than by reaching into the updater. A future edit that reintroduces an
 * unconditional allocation fails here, not in production on a phone.
 *
 * This file is deliberately separate from `ChatHomeScreen.stability.test.tsx`:
 * sibling lanes are editing the same screen, and a new file cannot conflict.
 */
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption, ChatThreadDetail } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

/** The thread that STREAMS. Older, so cold start does not select it — the
 *  churn is a LIST defect and must be provable without the transcript arm. */
const QUIET_ID = '019f0000-0000-7000-8000-000000000010' as EntityId;
/** The thread cold start opens, so the streaming row is never the active one. */
const OPEN_ID = '019f0000-0000-7000-8000-00000000001f' as EntityId;

function twoThreads(): ChatThreadDetail[] {
  const quiet = structuredClone(CHAT_HOME_FIXTURE_THREAD);
  quiet.summary = { ...quiet.summary, rootId: QUIET_ID, title: 'Plan the launch sequence' };
  const open = structuredClone(CHAT_HOME_FIXTURE_THREAD);
  open.summary = {
    ...open.summary,
    rootId: OPEN_ID,
    title: 'Draft the release note',
    // Newer than the quiet thread, and still old enough to bucket as Earlier.
    updatedAt: '2026-08-13T09:00:00.000Z',
  };
  return [quiet, open];
}

/** Let effects, the unknown-root list re-read and its state land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const titlesOf = (view: { container: HTMLElement }): string[] =>
  [...view.container.querySelectorAll('.tch-thread__title')].map((row) => row.textContent ?? '');

const groupsOf = (view: { container: HTMLElement }): string[] =>
  [...view.container.querySelectorAll('.tch-group__label')].map((label) => label.textContent ?? '');

describe('thread list churn — the mobile flicker', () => {
  it('publishes the list once per real state change, not once per streamed token', async () => {
    const { port, controls } = createChatHomeFixturePort(twoThreads());
    const onThreadsChange = vi.fn();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        onThreadsChange={onThreadsChange}
      />,
    );
    await waitFor(() => expect(titlesOf(view)).toHaveLength(2));

    const messageId = '019f0000-0000-7000-8000-0000000000d0' as EntityId;
    const delta = (seq: number) => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: QUIET_ID,
        messageId,
        seq,
        part: { kind: 'text', text: `token ${seq} ` },
      });
    };

    /* Reach the streaming steady state first. The FIRST frame for a root the
       list has not seen is a genuine list re-read (the handler's own
       unknown-root arm), and that read is allowed to publish — it is a new
       list. What must not publish is everything after it. */
    act(() => delta(0));
    await settle();
    act(() => delta(1));
    await waitFor(() => expect(view.getAllByLabelText('Agent is working').length).toBeGreaterThan(0));
    await settle();

    const before = titlesOf(view);
    onThreadsChange.mockClear();

    /* Forty more tokens of the SAME turn, EACH IN ITS OWN `act` — one commit
       per token, which is how a real stream arrives. Batching the burst into a
       single act would collapse forty renders into one and let the old
       `map`-every-frame code look almost innocent; separate commits is the
       shape that made the phone flicker. The row already says "live", so
       nothing it renders changes and the host must not hear a word. */
    for (let seq = 2; seq < 42; seq += 1) {
      const at = seq;
      act(() => delta(at));
    }
    await settle();

    expect(onThreadsChange).not.toHaveBeenCalled();
    expect(titlesOf(view)).toEqual(before);

    /* The turn ending IS a change — idle, and a timestamp worth sorting on.
       Exactly one publish, which is the point: the host re-renders per TURN,
       not per token. */
    act(() => {
      controls.emit({
        type: 'chat.turn.done',
        threadRootId: QUIET_ID,
        messageId,
        usage: { output_tokens: 7 },
      });
    });
    await settle();

    expect(onThreadsChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.queryAllByLabelText('Agent is working')).toHaveLength(0));
  });

  it('never reorders the list while an answer streams', async () => {
    const { port, controls } = createChatHomeFixturePort(twoThreads());
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(titlesOf(view)).toHaveLength(2));

    // Both fixture threads are days old, so both bucket as Earlier. A stamped
    // `updatedAt` would move the streaming row to a Today group at the top —
    // the reorder a reader saw mid-answer, made visible.
    expect(groupsOf(view)).toEqual(['Earlier']);
    const before = titlesOf(view);

    const messageId = '019f0000-0000-7000-8000-0000000000d1' as EntityId;
    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: QUIET_ID,
        messageId,
        seq: 0,
        part: { kind: 'text', text: 'thinking ' },
      });
    });
    await settle();
    act(() => {
      for (let seq = 1; seq < 20; seq += 1) {
        controls.emit({
          type: 'chat.turn.delta',
          threadRootId: QUIET_ID,
          messageId,
          seq,
          part: { kind: 'text', text: `word${seq} ` },
        });
      }
    });
    await waitFor(() => expect(view.getAllByLabelText('Agent is working').length).toBeGreaterThan(0));
    await settle();

    // Same rows, same order, same bucket — only the live pip was added.
    expect(groupsOf(view)).toEqual(['Earlier']);
    expect(titlesOf(view).map((title) => title.trim())).toEqual(
      before.map((title) => title.trim()),
    );

    // The turn is over: NOW the timestamp is real, and the row rises. One
    // reorder, at the moment "most recent first" actually changed.
    act(() => {
      controls.emit({
        type: 'chat.turn.done',
        threadRootId: QUIET_ID,
        messageId,
        usage: { output_tokens: 4 },
      });
    });
    await waitFor(() => expect(groupsOf(view)).toEqual(['Today', 'Earlier']));
    expect(titlesOf(view)[0]).toContain('Plan the launch sequence');
  });
});
