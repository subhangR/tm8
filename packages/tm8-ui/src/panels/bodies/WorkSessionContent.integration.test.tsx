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

it('mounts Chat under the same Content body only when the safe pinned projection enables it', () => {
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
      chatSurface={<div>canonical session feed</div>}
      onContentSurfaceChange={onContentSurfaceChange}
    />,
  );

  expect(getByRole('tablist', { name: /work session surface/i })).toBeTruthy();
  fireEvent.click(getByRole('tab', { name: 'Chat' }));
  expect(onContentSurfaceChange).toHaveBeenCalledWith('chat');
  expect(getByText('canonical session feed')).toBeTruthy();
});
