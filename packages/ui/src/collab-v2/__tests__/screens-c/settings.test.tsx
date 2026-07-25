/**
 * Space Settings (W3c) — profile, members/roles, invites, and task-axis
 * management (the add-axis round-trip is the one that matters: a new manual
 * axis must be indistinguishable from a default one afterwards).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../screens/settings';
import { createFacade, renderWith, resetStores, viewProps } from './helpers';

describe('Space Settings', () => {
  beforeEach(() => resetStores());
  afterEach(() => cleanup());

  it('renders the space profile from getSettings', async () => {
    const facade = createFacade();
    const settings = await facade.getSettings(facade.ids.space);

    renderWith(facade, <SettingsScreen {...viewProps(facade, { view: 'settings' })} />);
    const profile = await screen.findByTestId('settings-profile');
    expect(within(profile).getByText(settings.space.name)).toBeInTheDocument();
    expect(profile).toHaveTextContent(`${settings.space.memberCount} members`);
    if (settings.space.githubRepo) expect(profile).toHaveTextContent(settings.space.githubRepo);
  });

  it('lists members with their roles', async () => {
    const facade = createFacade();
    const settings = await facade.getSettings(facade.ids.space);
    expect(settings.members.length).toBeGreaterThan(1);

    renderWith(facade, <SettingsScreen {...viewProps(facade, { view: 'settings' })} />);
    const list = await screen.findByTestId('settings-members');
    for (const member of settings.members) {
      expect(await within(list).findByText(member.actor.displayName)).toBeInTheDocument();
    }
    const tally = await screen.findByTestId('settings-role-tally');
    expect(tally).toHaveTextContent('owner');
  });

  it('lists invites with their usage and state', async () => {
    const facade = createFacade();
    const settings = await facade.getSettings(facade.ids.space);
    expect(settings.invites.length).toBeGreaterThan(0);

    renderWith(facade, <SettingsScreen {...viewProps(facade, { view: 'settings' })} />);
    const invites = await screen.findByTestId('settings-invites');
    for (const invite of settings.invites) {
      expect(within(invites).getByText(invite.code)).toBeInTheDocument();
      expect(invites).toHaveTextContent(`${invite.uses}/${invite.maxUses} used`);
    }
  });

  it('lists every task axis, default and manual alike', async () => {
    const facade = createFacade();
    const axes = await facade.getTaskAxes(facade.ids.space);
    expect(axes.length).toBeGreaterThan(1);

    renderWith(facade, <SettingsScreen {...viewProps(facade, { view: 'settings' })} />);
    const list = await screen.findByTestId('settings-axes');
    for (const axis of axes) {
      const row = within(list).getByTestId(`settings-axis-${axis.name}`);
      expect(row).toHaveTextContent(axis.kind);
      for (const value of axis.axisValues) expect(row).toHaveTextContent(value);
    }
  });

  it('add-axis round-trips through the facade', async () => {
    const facade = createFacade();
    renderWith(facade, <SettingsScreen {...viewProps(facade, { view: 'settings' })} />);
    await screen.findByTestId('settings-axes');

    fireEvent.change(screen.getByLabelText('New axis name'), { target: { value: 'surface' } });
    fireEvent.change(screen.getByLabelText('New axis values'), { target: { value: 'ui, server, cli' } });
    fireEvent.click(screen.getByTestId('settings-axis-add'));

    const row = await screen.findByTestId('settings-axis-surface');
    expect(row).toHaveTextContent('manual');
    expect(row).toHaveTextContent('ui');
    expect(row).toHaveTextContent('cli');

    const axes = await facade.getTaskAxes(facade.ids.space);
    const created = axes.find((a) => a.name === 'surface');
    expect(created?.axisValues).toEqual(['ui', 'server', 'cli']);
  });

  it('rejects an axis with no name or values without calling the facade', async () => {
    const facade = createFacade();
    const before = await facade.getTaskAxes(facade.ids.space);
    renderWith(facade, <SettingsScreen {...viewProps(facade, { view: 'settings' })} />);
    await screen.findByTestId('settings-axes');

    fireEvent.click(screen.getByTestId('settings-axis-add'));
    expect(await screen.findByRole('alert')).toHaveTextContent('name and at least one value');
    expect(await facade.getTaskAxes(facade.ids.space)).toHaveLength(before.length);
  });

  it('edits a manual axis values list and deletes it; default axes offer no delete', async () => {
    const facade = createFacade();
    const axes = await facade.getTaskAxes(facade.ids.space);
    const manual = axes.find((a) => a.kind === 'manual')!;
    const preset = axes.find((a) => a.kind === 'default')!;

    renderWith(facade, <SettingsScreen {...viewProps(facade, { view: 'settings' })} />);
    await screen.findByTestId('settings-axes');

    expect(screen.queryByLabelText(`Delete ${preset.name}`)).toBeNull();

    fireEvent.click(screen.getByLabelText(`Edit ${manual.name}`));
    fireEvent.change(screen.getByLabelText(`Values for ${manual.name}`), {
      target: { value: 'v2-alpha, ga' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(async () => {
      const updated = (await facade.getTaskAxes(facade.ids.space)).find((a) => a.id === manual.id);
      expect(updated?.axisValues).toEqual(['v2-alpha', 'ga']);
    });

    fireEvent.click(screen.getByLabelText(`Delete ${manual.name}`));
    await waitFor(() => expect(screen.queryByTestId(`settings-axis-${manual.name}`)).toBeNull());
    expect((await facade.getTaskAxes(facade.ids.space)).some((a) => a.id === manual.id)).toBe(false);
  });
});
