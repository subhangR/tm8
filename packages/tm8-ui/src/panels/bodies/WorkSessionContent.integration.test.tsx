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
 * THE DEAD CONTROL THAT FINALLY HAS A DESTINATION.
 *
 * `TerminalBody` draws a "transcript ↗" chip on every session that is not live
 * (TerminalBody.tsx:298-306), and until the Transcript surface existed no host
 * passed `onOpenTranscript` — so it was an ENABLED button with
 * `onClick={undefined}`, the enabled-inert control the panel's honesty rules
 * ban everywhere else.
 *
 * It opens the surface by SELECTING it, which is why the assertion is on the
 * host's surface-change callback rather than on a pane: the host owns that
 * choice and round-trips it back as `requestedSurface`, exactly as it does for
 * the conversation surface's own way back to the terminal.
 */
it('the exited session’s transcript chip selects the Transcript surface', async () => {
  const source = fixtureDetails[sessionStale.id]!;
  const onContentSurfaceChange = vi.fn();
  const { findByTestId } = render(
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

  fireEvent.click(await findByTestId('transcript-chip'));
  expect(onContentSurfaceChange).toHaveBeenCalledWith('transcript');
});
