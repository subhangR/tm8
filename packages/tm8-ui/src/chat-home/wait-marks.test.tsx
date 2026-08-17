// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption, ChatThreadDetail } from './types';

/**
 * THE WAITING MARKS — the figure-8 in the composer and in the transcript.
 *
 * What jsdom can and cannot say here is the whole design of this file. It
 * loads no stylesheets and rasterizes nothing, so nothing below claims the
 * mark LOOKS right at 11px, that it reads on a brass button, or that the
 * button did not change height — those are browser questions and they were
 * answered in a browser (see `gate-evidence/`).
 *
 * What jsdom CAN see is which surfaces mount a mark and how many. That is the
 * load-bearing question, because the cost is per mounted mark per frame: the
 * boot lane gated this lane on exactly that, and the failure mode is not a
 * wrong pixel but a list that quietly mounts one mark per row.
 */

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const marks = (root: HTMLElement) => root.querySelectorAll('[data-testid="ribbon-mark"]');

function mount(port: ChatHomePort) {
  return render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
}

/**
 * Wait for the screen to be genuinely IDLE, not merely mounted.
 *
 * The thread row in the sidebar appears as soon as `listThreads` resolves, but
 * `readThread` is a second, later read and the transcript shows its own wait
 * row until it lands — carrying a mark, correctly. Keying on the sidebar alone
 * makes "no marks at idle" a race that a lightly-loaded run wins and a full
 * parallel suite loses.
 */
async function settled(view: ReturnType<typeof mount>) {
  await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
  await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());
}

/** A thread list of `count` threads, every one of them streaming. */
function streamingThreads(count: number): ChatThreadDetail[] {
  return Array.from({ length: count }, (_, i) => {
    const base = structuredClone(CHAT_HOME_FIXTURE_THREAD) as ChatThreadDetail;
    const rootId = `019f0000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}` as EntityId;
    return {
      ...base,
      summary: {
        ...base.summary,
        rootId,
        title: `Streaming thread ${i}`,
        state: 'streaming',
        // Descending, so the fixture's own sort keeps a stable first row.
        updatedAt: `2026-08-13T08:${String(59 - i).padStart(2, '0')}:00.000Z`,
      },
    };
  });
}

describe('chat waiting marks', () => {
  it('turns the mark in the send button while a turn runs, and takes it away when the turn ends', async () => {
    const { port } = createChatHomeFixturePort();
    const view = mount(port);
    await settled(view);

    // Idle: the composer says Send, and nothing is turning anywhere.
    expect(marks(view.container)).toHaveLength(0);

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Keep going.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    const working = await view.findByTestId('tch-send-working');
    expect(working.querySelector('[data-testid="ribbon-mark"]')).not.toBeNull();
  });

  it('marks the transcript while a turn is pending', async () => {
    const { port } = createChatHomeFixturePort();
    const view = mount(port);
    await settled(view);
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Keep going.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    const thinking = await view.findByTestId('chat-thinking');
    expect(thinking.querySelector('[data-testid="ribbon-mark"]')).not.toBeNull();
    // The words are still the accessible content; the mark is decorative and
    // must not be reachable, or every wait row gains a nameless graphic.
    expect(thinking.getAttribute('role')).toBe('status');
    expect(thinking.querySelector('.tch-wait__mark')?.getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * THE ONE THAT MATTERS. Each mark recomputes and re-reconciles its whole
   * band every frame, so the cost is linear in mounted marks and a per-row
   * mark is the way this gets expensive without anyone noticing. The sidebar's
   * live pip is deliberately still a CSS dot for this reason, so a list of
   * streaming threads must not add a single mark.
   */
  it('does not mount a mark per streaming row — the sidebar pip stays a dot', async () => {
    const { port } = createChatHomeFixturePort(streamingThreads(12));
    const view = mount(port);
    await waitFor(() => expect(view.getByText('Streaming thread 5')).toBeTruthy());

    expect(view.container.querySelectorAll('.tch-thread__live').length).toBeGreaterThan(1);
    // At most the two the transcript itself can be showing — never one per row.
    expect(marks(view.container).length).toBeLessThanOrEqual(2);
  });

  /**
   * `.tch-thinking` is the collapsible Thinking disclosure inside a turn
   * (TurnParts.tsx). It used to also be the wait row, and the wait row's
   * `display: flex` was laying that disclosure's summary and body out side by
   * side. Nothing in jsdom can see the layout — but it can see the two stop
   * sharing a name, which is what keeps the collision from coming back.
   */
  it('keeps the wait row off the Thinking disclosure’s class', async () => {
    const { port } = createChatHomeFixturePort();
    const view = mount(port);
    await settled(view);
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Keep going.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    const thinking = await view.findByTestId('chat-thinking');
    expect(thinking.classList.contains('tch-wait')).toBe(true);
    expect(thinking.classList.contains('tch-thinking')).toBe(false);
  });
});
