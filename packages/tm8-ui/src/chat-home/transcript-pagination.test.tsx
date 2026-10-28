// @vitest-environment jsdom
/**
 * A LONG CHAT PAGES LIKE A MESSAGING APP. The owner's report: a long
 * WhatsApp-bridged conversation "is not getting loaded" in the dashboard. The
 * port now opens at the newest page and hands out a cursor to older ones; this
 * is the screen half — the newest page renders first, reaching the top reads
 * the page before it, and the reader's line does not move when it lands.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatTurn } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const ROW_PX = 100;

const turn = (n: number): ChatTurn => ({
  messageId: `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}` as EntityId,
  role: 'user', author: null, createdAt: `2026-10-28T00:${String(n).padStart(2, '0')}:00.000Z`,
  body: `page message ${n}`, parts: [],
});

function pagedPort() {
  const { port } = createChatHomeFixturePort();
  const readOlderTurns = vi.fn(async (_chatId: EntityId, cursor: string) => (cursor === 'before-4'
    ? { turns: [1, 2, 3].map(turn), olderCursor: null }
    : { turns: [], olderCursor: null }));
  const paged: ChatHomePort = {
    ...port,
    async readThread(chatId) {
      const detail = await port.readThread(chatId);
      return { ...detail, turns: [4, 5, 6].map(turn), olderCursor: 'before-4' };
    },
    readOlderTurns,
  };
  return { port: paged, readOlderTurns };
}

/** jsdom does no layout: every rendered turn is ROW_PX tall, and scrollTop is a plain value. */
function layOut(element: HTMLElement) {
  let top = 0;
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true, get: () => element.querySelectorAll('article.tch-turn').length * ROW_PX,
  });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => ROW_PX * 2 });
  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
}

describe('paged chat transcript', () => {
  it('opens at the newest page, reads the older one at the top, and keeps the reader in place', async () => {
    const { port, readOlderTurns } = pagedPort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => view.getByText('page message 6'));
    expect(view.queryByText('page message 3')).toBeNull();
    expect(view.getByTestId('tch-older')).toBeTruthy();

    const transcript = view.container.querySelector('.tch-transcript') as HTMLElement;
    layOut(transcript);
    const rows = transcript.querySelectorAll('article.tch-turn').length;
    // The reader scrolls up to the very top of the newest page.
    transcript.scrollTop = 0;
    await act(async () => { fireEvent.scroll(transcript); });

    await waitFor(() => view.getByText('page message 1'));
    expect(readOlderTurns).toHaveBeenCalledTimes(1);
    expect(readOlderTurns.mock.calls[0]![1]).toBe('before-4');
    // Oldest first, no duplicates at the page edge.
    const bodies = [...transcript.querySelectorAll('article.tch-turn')].map((row) => row.textContent ?? '');
    expect(bodies.map((text) => /page message (\d+)/.exec(text)?.[1])).toEqual(['1', '2', '3', '4', '5', '6']);
    // ANCHORED: the turn that was at the top is still at the top — the new
    // rows went in above the viewport, so scrollTop moved by exactly their height.
    const added = transcript.querySelectorAll('article.tch-turn').length - rows;
    expect(added).toBe(3);
    expect(transcript.scrollTop).toBe(added * ROW_PX);
    // The first message of the chat is loaded: nothing older to offer.
    expect(view.queryByTestId('tch-older')).toBeNull();
  });

  it('reads the older page from the button too, once while it is in flight', async () => {
    const { port, readOlderTurns } = pagedPort();
    let release: () => void = () => undefined;
    readOlderTurns.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ turns: [1, 2, 3].map(turn), olderCursor: null });
    }));
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    // By test id, not role: a role query walks the whole screen's a11y tree.
    const button = await waitFor(() => view.getByTestId('tch-older').querySelector('button')!);
    expect(button.textContent).toBe('Load earlier messages');
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe('Loading earlier messages…'));
    fireEvent.click(button);
    expect(readOlderTurns).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await waitFor(() => view.getByText('page message 1'));
  });
});
