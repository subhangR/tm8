// @vitest-environment jsdom
/**
 * Kinds managed from Settings (task 01a0e036). Home lists every kind since the
 * 2026-09-27 ruling, including `credential` and `space_link`, whose human-only
 * doors live in Space settings. These pin that the list and the panel both
 * link there, and that a credential's tile draws only its non-secret facts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { getKind } from '../domain';
import { navStore, resetNav } from '../stores/navStore';
import { GenericBody } from './bodies/GenericBody';
import { renderBadge } from './list/tile-badges';

const credentialState = {
  kind: 'credential',
  provider: 'anthropic',
  shape: 'api_key',
  visibility: 'private',
  status: 'active',
  ownerAccountId: null,
} as const;

function credentialDetail(): EntityDetail {
  return {
    id: '01a0e036-0000-7000-8000-000000000001',
    kind: 'credential',
    title: 'Team Anthropic key',
    state: credentialState,
    content: credentialState,
    connections: { incoming: [], outgoing: [] },
  } as unknown as EntityDetail;
}

beforeEach(() => resetNav('space-1'));

describe('a kind with a Settings home', () => {
  it('names Space credentials for `credential` and Space links for `space_link`', () => {
    expect(getKind('credential').settingsHome?.section).toBe('space-credentials');
    expect(getKind('space_link').settingsHome?.section).toBe('space-links');
    // Still no create door on Home — the server refuses a generic create.
    for (const kind of ['credential', 'space_link', 'server', 'interaction_profile']) {
      expect(getKind(kind).list.quickCreate).toBe(false);
    }
  });

  it('draws the panel link from the registry row, and it opens that section', () => {
    const detail = credentialDetail();
    const view = render(<GenericBody detail={detail} blocks={getKind('credential').panel.blocks} />);
    const link = view.getByTestId('settings-home-link');
    expect(link.textContent).toContain('Space credentials');
    fireEvent.click(link);
    expect(navStore.getState().view).toEqual({ view: 'settings', section: 'space-credentials' });
    view.unmount();
  });

  it('shows a credential as provider and visibility only — the tile has no secret source', () => {
    const row = { kind: 'credential', state: credentialState } as unknown as EntitySummary;
    const sources = getKind('credential').list.tile.badges.map((badge) => badge.source);
    expect(sources).toEqual(['provider', 'visibility']);
    expect(sources.map((source) => renderBadge(source, row))).toEqual([
      { slot: 'meta', text: 'anthropic' },
      { slot: 'meta', text: 'private' },
    ]);
  });
});
