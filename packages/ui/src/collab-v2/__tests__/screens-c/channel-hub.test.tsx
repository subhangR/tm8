/**
 * Channel Hub (W3c) — header, pinned shelf, and AUTO-TABS.
 *
 * The parity test is the important one: the tab strip must be the facade's
 * `getChannelTabs` projection rendered 1:1 (same keys, labels, counts, order).
 * If a screen ever hand-derives tabs from edges, this fails.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { ChannelHub } from '../../screens/channel';
import { createFacade, renderWith, resetStores, viewProps } from './helpers';

describe('Channel Hub', () => {
  beforeEach(() => resetStores());
  afterEach(() => cleanup());

  it('renders the header — channel name, topic, and the live rollups', async () => {
    const facade = createFacade();
    const channel = await facade.getEntity(facade.ids.chBuild);
    renderWith(facade, <ChannelHub {...viewProps(facade, { entityId: facade.ids.chBuild })} />);

    const hub = await screen.findByTestId('view-channel');
    expect(hub).toHaveAttribute('data-channel', facade.ids.chBuild);
    expect(await screen.findByText(channel.title)).toBeInTheDocument();
    if (channel.state.kind === 'channel' && channel.state.topic) {
      expect(screen.getByText(channel.state.topic)).toBeInTheDocument();
    }
  });

  it('shelves the pinned entities as Z2 cards', async () => {
    const facade = createFacade();
    const detail = await facade.getEntity(facade.ids.chBuild);
    const pinned = detail.content.kind === 'channel' ? detail.content.pinned : [];
    expect(pinned.length).toBeGreaterThan(0);

    renderWith(facade, <ChannelHub {...viewProps(facade, { entityId: facade.ids.chBuild })} />);
    const shelf = await screen.findByTestId('channel-shelf');
    for (const item of pinned) {
      expect(within(shelf).getByText(item.title)).toBeInTheDocument();
    }
  });

  it('renders auto-tabs at exact parity with the facade projection', async () => {
    const facade = createFacade();
    const tabs = await facade.getChannelTabs(facade.ids.chBuild);
    expect(tabs[0].key).toBe('feed');
    expect(tabs.length).toBeGreaterThan(1); // the seed attaches tasks/docs/team/PRs

    renderWith(facade, <ChannelHub {...viewProps(facade, { entityId: facade.ids.chBuild })} />);
    const strip = await screen.findByTestId('channel-tabs');

    await waitFor(() => {
      expect(within(strip).getAllByRole('tab')).toHaveLength(tabs.length);
    });
    const rendered = within(strip).getAllByRole('tab');
    expect(rendered.map((el) => el.getAttribute('data-tab'))).toEqual(tabs.map((t) => t.key));
    rendered.forEach((el, i) => {
      expect(el).toHaveTextContent(tabs[i].label);
      expect(el).toHaveTextContent(String(tabs[i].count));
    });
  });

  it('opens the Feed tab first and renders the thread composer', async () => {
    const facade = createFacade();
    renderWith(facade, <ChannelHub {...viewProps(facade, { entityId: facade.ids.chBuild })} />);

    expect(await screen.findByTestId('channel-pane-feed')).toBeInTheDocument();
    const messages = await facade.getMessages(facade.ids.chBuild, { order: 'asc' });
    const first = messages.items[0];
    if (first.content.kind === 'message') {
      expect(await screen.findByText(new RegExp(first.content.body.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    }
  });

  it('clicking a tab renders that ChannelTab.query through CollectionView', async () => {
    const facade = createFacade();
    const tabs = await facade.getChannelTabs(facade.ids.chBuild);
    const tasksTab = tabs.find((t) => t.key === 'tasks');
    expect(tasksTab).toBeTruthy();
    const expected = await facade.queryCollection(tasksTab!.query);
    expect(expected.page.items.length).toBeGreaterThan(0);

    renderWith(facade, <ChannelHub {...viewProps(facade, { entityId: facade.ids.chBuild })} />);
    const strip = await screen.findByTestId('channel-tabs');
    await waitFor(() => expect(within(strip).getAllByRole('tab').length).toBe(tabs.length));

    fireEvent.click(within(strip).getByText('Tasks'));

    const pane = await screen.findByTestId('channel-pane-tasks');
    for (const item of expected.page.items) {
      expect(await within(pane).findByText(item.title)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('channel-pane-feed')).toBeNull();
  });

  it('falls back to the space first channel when the route carries no entity', async () => {
    const facade = createFacade();
    const navigation = await facade.getNavigation(facade.ids.space);
    const firstChannel = navigation.channels[0].entity;

    renderWith(facade, <ChannelHub {...viewProps(facade, { entityId: null })} />);
    await waitFor(() => {
      expect(screen.getByTestId('view-channel')).toHaveAttribute('data-channel', firstChannel.id);
    });
  });
});
