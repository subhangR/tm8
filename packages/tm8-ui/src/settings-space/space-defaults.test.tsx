// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitySummary, SpaceSummary } from '@tm8/contract';
import type { SpaceDefaultsPort } from '../data/space-defaults-port';
import { SpaceAccessSection } from './SpaceAccessSection';
import { InteractionProfilesSection } from './InteractionProfilesSection';
import { ProfileSection } from './ProfileSection';

afterEach(cleanup);

const space = (over: Partial<SpaceSummary> = {}): SpaceSummary => ({
  id: 'space-1' as SpaceSummary['id'],
  name: 'Atelier',
  description: '',
  memberCount: 2,
  unreadTotal: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const entity = (id: string, title: string, state?: unknown): EntitySummary =>
  ({ id, title, state } as unknown as EntitySummary);

function port(over: Partial<SpaceDefaultsPort> = {}): SpaceDefaultsPort {
  return {
    loadDefaults: vi.fn(async () => ({ revision: 7, defaultChannelId: null, defaultInteractionProfileId: null })),
    loadChannels: vi.fn(async () => [entity('ch-1', 'general'), entity('ch-2', 'random')]),
    loadProfiles: vi.fn(async () => []),
    ...over,
  };
}

describe('Space profile: visibility and default channel', () => {
  it('saves visibility through the space update and the default channel through its own command', async () => {
    const onSave = vi.fn(async () => undefined);
    const setDefaultChannel = vi.fn(async () => undefined);
    render(
      <ProfileSection
        space={space({ visibility: 'private' })}
        heading="Space profile"
        onSave={onSave}
        defaults={port({ setDefaultChannel })}
      />,
    );
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'public' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save space details' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public' })));

    const channel = await screen.findByLabelText('Channel members open first');
    fireEvent.change(channel, { target: { value: 'ch-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save default channel' }));
    await waitFor(() => expect(setDefaultChannel).toHaveBeenCalledWith('ch-2', 7));
  });

  it('shows the default channel read-only to a member', async () => {
    render(
      <ProfileSection
        space={space()}
        heading="Space profile"
        defaults={port({ loadDefaults: async () => ({ revision: 1, defaultChannelId: 'ch-1', defaultInteractionProfileId: null }) })}
      />,
    );
    await screen.findByText('Members open general first.');
    expect(screen.queryByLabelText('Channel members open first')).toBeNull();
  });
});

describe('Access & style', () => {
  it('turns the space password on with the caller password, and shows the server refusal', async () => {
    const setPasswordRequired = vi
      .fn()
      .mockRejectedValueOnce(new Error('a space password needs TM8_SPACE_SESSIONS=enforce'))
      .mockResolvedValueOnce({ spaceId: 'space-1', requireSpacePassword: true, revokedSessionIds: ['s1'] });
    render(
      <SpaceAccessSection
        heading="Access & style"
        space={space({ requireSpacePassword: false })}
        port={port({ setPasswordRequired })}
        canEdit
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Require a space password' }));
    expect((await screen.findByRole('alert')).textContent).toContain('TM8_SPACE_SESSIONS=enforce');
    fireEvent.change(screen.getByLabelText(/Your space password/), { target: { value: 'hunter22hunter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Require a space password' }));
    await screen.findByText(/Space password required\. 1 session/);
    expect(setPasswordRequired).toHaveBeenLastCalledWith(true, 'hunter22hunter');
    expect(screen.getByRole('button', { name: 'Stop requiring a space password' })).toBeTruthy();
  });

  it('sets the default style with the revision it read', async () => {
    const setStyleDefault = vi.fn(async () => undefined);
    const loadStyle = vi.fn(async () => ({
      defaultStyle: 'builtin:atelier-light',
      revision: 3,
      styles: [
        { origin: 'builtin', ref: 'builtin:atelier-light', title: 'Atelier light' },
        { origin: 'space', ref: 'space:abc', title: 'House' },
      ] as never,
    }));
    render(<SpaceAccessSection heading="Access & style" space={space()} port={port({ loadStyle, setStyleDefault })} canEdit />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Default style' }), { target: { value: 'space:abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save default style' }));
    await waitFor(() => expect(setStyleDefault).toHaveBeenCalledWith('space:abc', 3));
  });

  it('refuses every control for a member', async () => {
    render(<SpaceAccessSection heading="Access & style" space={space({ requireSpacePassword: true })} port={port({ setPasswordRequired: vi.fn() })} canEdit={false} />);
    expect(screen.getByText('Currently: required')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop requiring a space password' })).toBeNull();
  });
});

describe('Interaction profiles', () => {
  it('mounts the governance list and sets the space default to an active profile', async () => {
    const setDefaultProfile = vi.fn(async () => undefined);
    const profiles = [
      entity('p-1', 'Calm', { kind: 'interaction_profile', status: 'active', activeVersion: 2, currentDraftVersion: 2 }),
      entity('p-2', 'Draft one', { kind: 'interaction_profile', status: 'draft', activeVersion: null, currentDraftVersion: 1 }),
    ];
    render(
      <InteractionProfilesSection
        heading="Interaction profiles"
        spaceName="Atelier"
        port={port({ loadProfiles: async () => profiles, setDefaultProfile })}
        canEdit
      />,
    );
    const picker = await screen.findByLabelText('Default profile');
    const options = within(picker as HTMLElement).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Core default (no space default)', 'Calm']);
    fireEvent.change(picker, { target: { value: 'p-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save default profile' }));
    await waitFor(() => expect(setDefaultProfile).toHaveBeenCalledWith('p-1', 7));
    expect(screen.getByTestId('interaction-profiles-screen')).toBeTruthy();
  });
});
