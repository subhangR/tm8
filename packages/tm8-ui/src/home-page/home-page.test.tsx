// @vitest-environment jsdom
/**
 * HomePage — Home IS the chat view (R4, 2026-08-15; formerly the merged
 * single home of task 01a0027d).
 *
 * What these pin, each against a failure mode the program has shipped once:
 *   - the chat slot fills the canvas (the host's surface renders, untouched);
 *   - NO attention section, even with a pending queue mounted — the tab bar's
 *     attention segment is the only entry (Subhang, 2026-09-27);
 *   - no credential surface stacks above the chat; and
 *   - the retired glance rails and presence/footer framing stay retired.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AttentionRequest } from '@tm8/contract';
import { AttentionApiProvider, type AttentionApi, type AttentionQueueRow } from '../attention';
import { HomePage } from './HomePage';

function renderPage(wrap: (page: ReactNode) => ReactNode = (page) => page) {
  return render(
    <div className="cv2-root">
      {wrap(
        <HomePage
          chat={(
            <div data-testid="chat-slot">
              the chat hero
              <div data-testid="sessions-content">Sessions content</div>
            </div>
          )}
        />,
      )}
    </div>,
  );
}

/** A queue with one pending request of mine — what used to fill NEEDS YOU. */
function pendingApi(): AttentionApi {
  const request = {
    id: 'req-1',
    entityId: 'task-1',
    rootId: 'task-1',
    reason: 'Pick retry policy',
  } as unknown as AttentionRequest;
  const row = {
    rootId: 'task-1',
    title: 'Wire refund webhook',
    kind: 'task',
    chip: null,
    requests: [request],
    latest: request,
    seen: false,
    mine: true,
    rolledUp: 0,
  } as unknown as AttentionQueueRow;
  return {
    status: 'ready',
    error: null,
    undo: null,
    chipFor: () => null,
    raisedChipFor: () => null,
    counts: () => ({ mine: 1, all: 1 }),
    queue: () => [row],
    requestsFor: () => [request],
    markSeen: vi.fn(async () => {}),
    resolve: vi.fn(async () => true),
    unresolve: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    reply: vi.fn(async () => true),
    refresh: vi.fn(),
  };
}

/** The chat section must be the ONLY child of the page column. */
function expectChatDirectlyInPage(getByTestId: (id: string) => HTMLElement) {
  const chatSurface = getByTestId('sessions-content').closest('.hp-chat');
  expect(chatSurface).toBeTruthy();
  const page = chatSurface!.parentElement;
  expect(page?.classList.contains('hp-page')).toBe(true);
  expect(page!.children).toHaveLength(1);
}

describe('the home chat canvas', () => {
  it('renders the chat slot as the canvas', () => {
    const { getByTestId } = renderPage();
    expect(within(getByTestId('home-page')).getByTestId('chat-slot')).toBeTruthy();
  });

  /* THE REMOVAL, ASSERTED (Subhang, 2026-09-05). Home used to stack the full
     credential block and the compact provider rail above the chat. Both are
     gone: the flow they belonged to is `CredentialsSetupDialog`, and the
     management surface is Settings. The testids are named rather than a count,
     because a count is satisfied by a section that moved elsewhere on the page. */
  it('renders NO credential surface, and seats the chat directly in the page column', () => {
    const { getByTestId, queryByTestId } = renderPage();

    for (const testid of [
      'home-credentials',
      'home-provider-rail',
      'credentials-provider-block',
      'provider-rail',
    ]) {
      expect(queryByTestId(testid), `${testid} still mounts on Home`).toBeNull();
    }
    expectChatDirectlyInPage(getByTestId);
  });

  /* THE REMOVAL, ASSERTED (Subhang, 2026-09-27). A NEEDS YOU strip rode above
     the chat and pushed it down. Attention's only entry on Home is the tab
     bar's segment now — so a PENDING queue must still leave the chat as the
     page column's first and only child. */
  it('renders NO attention section, even with a pending attention queue', () => {
    const { getByTestId, queryByTestId, queryByText } = renderPage((page) => (
      <AttentionApiProvider api={pendingApi()}>{page}</AttentionApiProvider>
    ));
    expect(queryByTestId('hp-needs-you')).toBeNull();
    expect(queryByText(/NEEDS YOU/)).toBeNull();
    expect(queryByText('Wire refund webhook')).toBeNull();
    expectChatDirectlyInPage(getByTestId);
  });

  it('keeps the retired glance rails, presence row and workspace footer out of Home', () => {
    const { container, queryByTestId, queryByText } = renderPage();
    expect(queryByTestId('hp-rail-tasks')).toBeNull();
    expect(queryByTestId('hp-rail-sessions')).toBeNull();
    expect(queryByTestId('hp-rail-docs')).toBeNull();
    expect(queryByTestId('hp-presence')).toBeNull();
    expect(queryByText('Open full workspace ⌗')).toBeNull();
    expect(container.querySelector('.hp-card')).toBeNull();
  });
});
