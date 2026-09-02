// @vitest-environment jsdom
/**
 * A DELIBERATELY EMPTY COMPOSER IS A SELECTION, and nothing in the background
 * may take it.
 *
 * Reported as "new conversation is buggy": the composer was silently replaced
 * by somebody else's conversation. `refreshThreads` resolved the selection with
 * `preferRoot ?? current ?? next[0]?.rootId ?? null`, and `null` is EXACTLY the
 * state New conversation puts the screen in — so `??` read the viewer's
 * composer as "nothing chosen yet" and filled it with the most recent thread.
 * The subscribe handler runs a refresh for every frame from a root the list has
 * not seen, so in a space with other members or working agents that fired
 * constantly, and on a phone the composer is the whole screen.
 *
 * Each `it` was written against the broken tree first and seen to fail. The
 * note on each says which line it hinges on.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption, ChatThreadSummary } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

/** Somebody ELSE's conversation — the one that used to arrive and take over. */
const OTHER_ROOT = '019f0000-0000-7000-8000-0000000000aa' as EntityId;
const OTHER_SUMMARY: ChatThreadSummary = {
  ...CHAT_HOME_FIXTURE_THREAD.summary,
  rootId: OTHER_ROOT,
  title: "Another member's conversation",
  preview: 'Started by somebody else entirely.',
  // Newer than the fixture thread, so `listThreads` returns it FIRST and the
  // old `?? next[0]?.rootId` chain would land on exactly this.
  updatedAt: '2026-08-20T09:00:00.000Z',
};

/**
 * The fixture port plus a conversation that shows up mid-session, the way
 * another member's does. Until `arrive()` the list does not know the root at
 * all — which is what makes the subscribe handler's `refreshThreads()` fire.
 */
function portWithLateArrival() {
  const { port: base, controls } = createChatHomeFixturePort();
  let extra: readonly ChatThreadSummary[] = [];
  const port: ChatHomePort = {
    ...base,
    async listThreads(spaceId) {
      return [...extra, ...(await base.listThreads(spaceId))];
    },
    async readThread(rootId) {
      if (rootId === OTHER_ROOT) return { summary: OTHER_SUMMARY, turns: [] };
      return base.readThread(rootId);
    },
  };
  return {
    port,
    /** Publish a frame for the newcomer, exactly as the live port would. */
    async speak() {
      extra = [OTHER_SUMMARY];
      await act(async () => {
        controls.emit({
          type: 'chat.turn.delta',
          threadRootId: OTHER_ROOT,
          messageId: '019f0000-0000-7000-8000-0000000000ab' as EntityId,
          seq: 1,
          text: 'Somebody else is talking.',
        });
      });
      // The refresh is a promise chain off the frame; let it settle.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

/** `MobileShell`'s wiring, to the letter: the selection is shell state, pushed
 *  down as `routeThreadId` and taken back through `onSelectionChange`, and the
 *  drawer's New conversation verb is `setThreadId(null)`. */
function PhoneHost({ port }: { port: ChatHomePort }) {
  const [threadId, setThreadId] = useState<EntityId | null>(null);
  return (
    <>
      <button type="button" onClick={() => setThreadId(null)}>
        Host new conversation
      </button>
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        soloConversation
        routeThreadId={threadId}
        onSelectionChange={setThreadId}
      />
    </>
  );
}

/* THE WORD IS "CHAT" NOW, EVERYWHERE ON THIS SURFACE (2026-08-30 Home
   restructure). The greeting used to read "New conversation — pick a mode…";
   the screen calls the thing a chat in its verbs, its rail row and its empty
   state, and one surface calling one object two names is the defect this
   rename closes. The CLAIM is unchanged — the composer greets you where no
   thread is open — only the string it is spelled with. */
const GREETING = /New chat — pick a mode/;

/* THE READINESS PROBES BELOW ARE EXACT-MATCH NOW, AND THE LOOSENESS WAS THE
   ACCIDENT. They read `getByText(/Plan the launch sequence/)`, which also
   matched the thread's FIRST TURN — "Plan the launch sequence and check what is
   already blocked." — and passed only because a solo host drew the title
   nowhere else. It draws it in `.tch-conversation__head` again (2026-08-30: the
   head was suppressed for every solo host on the reasoning that Craft's picker
   prints it, which is true of Craft and of neither of the other two), so the
   substring matched twice and `getByText` refuses two.

   The claim each of these makes is unchanged and is not about counting: "the
   cold-start auto-open landed on the most recent conversation". The exact
   string names the conversation's own head — the one place that STATES which
   thread is open, rather than a turn that happens to quote it. The desktop
   probe further down keeps the regex: there the thread column names it too, so
   the head is not the sole namer and the case is not about solo at all. */

describe('a new conversation the viewer opened survives the space being busy', () => {
  /**
   * HINGES ON: `refreshThreads`' selection arm. Put
   * `setSelectedRootId((current) => preferRoot ?? current ?? next[0]?.rootId ?? null)`
   * back and this reds — the composer is replaced by "Another member's
   * conversation" the moment the frame lands.
   */
  it('keeps the composer when another member starts talking', async () => {
    const { port, speak } = portWithLateArrival();
    const view = render(<PhoneHost port={port} />);

    // Cold start does its job first: the most recent conversation opens itself.
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    fireEvent.click(view.getByRole('button', { name: 'Host new conversation' }));
    await waitFor(() => expect(view.getByText(GREETING)).toBeTruthy());

    await speak();

    expect(view.getByText(GREETING)).toBeTruthy();
    expect(view.queryByText("Another member's conversation")).toBeNull();
  });

  /**
   * HINGES ON: the same arm. The draft key is `selectedRootId ?? 'new-thread'`,
   * so a stolen selection does not merely change the screen — it hides what the
   * viewer had already typed.
   */
  it('keeps the draft that was typed into it', async () => {
    const { port, speak } = portWithLateArrival();
    const view = render(<PhoneHost port={port} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    fireEvent.click(view.getByRole('button', { name: 'Host new conversation' }));
    await waitFor(() => expect(view.getByText(GREETING)).toBeTruthy());

    const box = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Half a thought I am still writing' } });

    await speak();

    expect((view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).value).toBe(
      'Half a thought I am still writing',
    );
  });

  /**
   * HINGES ON: the same arm, from the DESKTOP entry point — the root header's
   * New chat. The defect was never phone-only; the phone is only where it costs
   * the entire screen.
   */
  it('keeps the composer opened from the screens own New chat', async () => {
    const { port, speak } = portWithLateArrival();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText(/Plan the launch sequence/)).toBeTruthy());

    fireEvent.click(view.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(view.getByText(GREETING)).toBeTruthy());

    await speak();

    expect(view.getByText(GREETING)).toBeTruthy();
  });

  /**
   * HINGES ON: the guard on the cold-start effect's `setSelectedRootId`. That
   * effect re-runs on more than a first mount, and unconditionally opening the
   * most recent conversation on each re-run discarded a pending new
   * conversation just as surely as the refresh did.
   */
  it('keeps the composer across a re-run of the cold-start read', async () => {
    const { port } = portWithLateArrival();
    const view = render(<PhoneHost port={port} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    fireEvent.click(view.getByRole('button', { name: 'Host new conversation' }));
    await waitFor(() => expect(view.getByText(GREETING)).toBeTruthy());

    // A new port object is all it takes — the effect is keyed `[port, spaceId]`.
    view.rerender(<PhoneHost port={{ ...port }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.getByText(GREETING)).toBeTruthy();
  });
});

describe('the cold-start auto-open still opens the most recent conversation', () => {
  /**
   * The other half of the fix: "nothing has been chosen yet" had to stay
   * distinguishable in BOTH directions. A genuine cold start — no selection
   * ever made — must still land on a conversation rather than the composer, or
   * the phone has no way in at all.
   */
  it('opens it on a genuine cold start, with the host holding null', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<PhoneHost port={port} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    expect(view.queryByText(GREETING)).toBeNull();
  });

  /** An empty space really is a new conversation — the composer is the cold
   *  start's own answer there, not a fallback. */
  it('lands on the composer when the space has no conversations', async () => {
    const { port } = createChatHomeFixturePort([]);
    const view = render(<PhoneHost port={port} />);
    await waitFor(() => expect(view.getByText(GREETING)).toBeTruthy());
  });
});

describe('a caller that names a root still moves the selection', () => {
  /**
   * `preferRoot` is the one contract left that moves the selection, and the
   * first send depends on it: the thread it just created has to become the open
   * one. A fix that froze the selection outright would break sending.
   */
  it('adopts the root a first message creates', async () => {
    const { port } = createChatHomeFixturePort([]);
    const view = render(<PhoneHost port={port} />);
    await waitFor(() => expect(view.getByText(GREETING)).toBeTruthy());

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Start something.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(view.queryByText(GREETING)).toBeNull());
  });
});
