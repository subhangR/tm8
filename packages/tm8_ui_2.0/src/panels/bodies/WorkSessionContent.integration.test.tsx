// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { EntityDetail } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureDetails, sessionStale } from '../../fixtures';
import { EntityDetailPanel, type DetailReasons } from '../EntityDetailPanel';

const REASONS: DetailReasons = {
  presenceHollow: 'Presence is unavailable.',
  versionHistory: 'Version history is unavailable.',
  provenanceHollow: 'Provenance is unavailable.',
  shareUnavailable: 'Sharing is unavailable.',
  withdrawUnavailable: 'Withdrawal is unavailable.',
};

// The host composes the conversation surface and hands it in through ONE slot;
// the panel mounts it under the Transcript chip. This is the seam
// `conversationSurfaceFor` fills for all five hosts — the assertion is that the
// panel does not build the surface itself and does not gate it on the pin.
it('mounts the host-composed conversation surface under the Transcript chip', () => {
  const source = fixtureDetails[sessionStale.id]!;
  const detail = {
    ...source,
    content: {
      ...source.content,
      interactionProfile: {
        pinRevision: 1,
        templateKey: 'chat.agent.canonical',
        templateVersion: 1,
        compatibility: 'supported',
        chatEnabled: true,
        initialContentSurface: 'terminal',
        feedPolicy: {
          scope: 'session_chat_v1', defaultLimit: 50, maxLimit: 200, includeActivity: true,
        },
        composerPolicy: {
          maxBodyChars: 12_000,
          allowedAttachmentKinds: ['file'],
          operationBindings: { post: 'messages.post' },
        },
      },
    },
  } as EntityDetail;
  const onContentSurfaceChange = vi.fn();
  const { getByRole, getByText } = render(
    <EntityDetailPanel
      detail={detail}
      reasons={REASONS}
      ctx={{ spaceId: FIXTURE_SPACE_ID }}
      liveness="stale"
      contentSurface="terminal"
      conversationSurface={<div>canonical session feed</div>}
      onContentSurfaceChange={onContentSurfaceChange}
    />,
  );

  expect(getByRole('tablist', { name: /work session surface/i })).toBeTruthy();
  fireEvent.click(getByRole('tab', { name: 'Transcript' }));
  expect(onContentSurfaceChange).toHaveBeenCalledWith('transcript');
  expect(getByText('canonical session feed')).toBeTruthy();
});

/**
 * THE DEAD CONTROL THAT GOT A DESTINATION, THEN GOT REMOVED.
 *
 * `TerminalBody` used to draw a "transcript ↗" chip on every session that was
 * not live. Until the Transcript surface existed no host passed
 * `onOpenTranscript`, so it was an ENABLED button with `onClick={undefined}` —
 * the enabled-inert control the panel's honesty rules ban everywhere else.
 * Wiring it to select the surface fixed that.
 *
 * The 2026-08-19 ruling then took the whole floating overlay off the canvas,
 * chip included. This is the ONE removal in that ruling that costs nothing:
 * the chip was a shortcut to the Transcript TAB, and the test directly above
 * proves that tab selects the same surface through the same callback. So the
 * assertion inverts — the chip must be gone, and the tab must still work —
 * rather than being deleted, which would leave no record that a way to the
 * transcript is still required of this panel.
 */
it('the exited session has no transcript chip — the Transcript tab is the way', async () => {
  const source = fixtureDetails[sessionStale.id]!;
  const onContentSurfaceChange = vi.fn();
  const { queryByTestId, findByRole } = render(
    <EntityDetailPanel
      detail={source}
      reasons={REASONS}
      ctx={{ spaceId: FIXTURE_SPACE_ID }}
      liveness="not-running"
      contentSurface="terminal"
      conversationSurface={<div>transcript surface</div>}
      onContentSurfaceChange={onContentSurfaceChange}
    />,
  );

  expect(queryByTestId('transcript-chip')).toBeNull();
  fireEvent.click(await findByRole('tab', { name: 'Transcript' }));
  expect(onContentSurfaceChange).toHaveBeenCalledWith('transcript');
});
