// @vitest-environment jsdom
/**
 * FINDING #4 — the Discussion tab's skeletons must RESOLVE.
 *
 * The tab drew three `.chs-skeleton` rows while `loading && !page`, and on an
 * empty feed they never resolved: the read settled with an empty page, and the
 * surface had to move to the hollow empty state, not eternal loading.
 */
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent, EntityFeedPage } from '@tm8/contract';
import { DiscussionSurface } from '../../channel-screen/DiscussionSurface';

const ANCHOR_ID = '01900000-0000-7000-8000-000000000201';

const EMPTY_PAGE: EntityFeedPage = {
  resolvedScope: 'session_chat_v1',
  predicates: ['anchored'],
  items: [],
  nextCursor: null,
};

function harness(feedImpl?: () => Promise<EntityFeedPage>) {
  const eventListeners = new Set<(event: DurableWorkspaceEvent) => void>();
  const feed = vi.fn(feedImpl ?? (() => Promise.resolve(EMPTY_PAGE)));
  const postMessage = vi.fn().mockResolvedValue({ patches: [] });
  return {
    feed,
    seam: {
      feed,
      commands: { postMessage },
      onEvent(listener: (event: DurableWorkspaceEvent) => void) {
        eventListeners.add(listener);
        return () => {
          eventListeners.delete(listener);
        };
      },
      onConnection() {
        return () => undefined;
      },
      onResync() {
        return () => undefined;
      },
    },
  };
}

describe('Discussion tab empty feed', () => {
  it('settles an empty read into the empty state, never eternal skeletons', async () => {
    const h = harness();
    /* StrictMode, deliberately — `main.tsx` renders under it, and the defect
       lived exactly there: the double-invoked effect re-attached a controller
       whose `dispose()` had permanently muted its store writes, so the settled
       empty read never reached the screen. */
    const { container } = render(
      <StrictMode>
        <DiscussionSurface
          seam={h.seam}
          anchorId={ANCHOR_ID}
          anchorNoun="this task"
          spaceId="01900000-0000-7000-8000-000000000202"
          viewerMemberId="member-1"
          connection={{ phase: 'live' }}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(h.feed).toHaveBeenCalled());
    await waitFor(() => {
      expect(container.querySelector('.chs-skeleton')).toBeNull();
    });
    // The hollow empty state, not a blank list.
    expect(screen.queryByTestId('chs-empty') ?? container.querySelector('.chs-empty')).not.toBeNull();
  });
});
