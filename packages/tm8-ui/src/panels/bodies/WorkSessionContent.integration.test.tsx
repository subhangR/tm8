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
