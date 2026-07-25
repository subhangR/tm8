/**
 * Home (My Work) — the three presets render from the seeded world, PULL runs
 * the facade command, and an agent's in-flight work is attributed to its owner.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HomeScreen, homeViews } from '../../screens/home';
import { useToastStore } from '../../subsystems/live';
import { createFacade, renderWith, resetStores, viewProps } from './helpers';

describe('HomeScreen', () => {
  beforeEach(() => { resetStores(); });

  it('registers itself as the `home` view', () => {
    expect(homeViews.home).toBe(HomeScreen);
  });

  it('renders the three work presets from the seeded world', async () => {
    const facade = createFacade();
    renderWith(facade, <HomeScreen {...viewProps(facade)} />);

    const ready = await screen.findByTestId('home-ready');
    expect(await within(ready).findByText(/T-103 · Facade routes/)).toBeInTheDocument();

    const inFlight = await screen.findByTestId('home-inflight');
    expect(await within(inFlight).findByText(/T-104 · Entity panel UI/)).toBeInTheDocument();

    const needsMe = await screen.findByTestId('home-needsme');
    expect(await within(needsMe).findByText(/T-106 · Docs reader/)).toBeInTheDocument();
  });

  it('renders the compact activity feed', async () => {
    const facade = createFacade();
    renderWith(facade, <HomeScreen {...viewProps(facade)} />);
    const feed = await screen.findByTestId('home-activity');
    await waitFor(() => expect(feed.querySelectorAll('.cv2-home__act').length).toBeGreaterThan(0));
  });

  it('PULL on a ready row runs facade.pullEntity with the pinned version and toasts', async () => {
    const facade = createFacade();
    const pull = vi.spyOn(facade, 'pullEntity');
    renderWith(facade, <HomeScreen {...viewProps(facade)} />);

    const button = await screen.findByTestId(`pull-${facade.ids.t103}`);
    const before = await facade.getEntity(facade.ids.t103);
    fireEvent.click(button);

    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    expect(pull.mock.calls[0][0]).toBe(facade.ids.t103);
    expect(pull.mock.calls[0][1].pinnedVersion).toBe(before.version);

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => t.kind === 'success' && /Pulled/.test(t.message))).toBe(true);
    });
  });

  it('surfaces a failed PULL as an error toast instead of a broken row', async () => {
    const facade = createFacade();
    vi.spyOn(facade, 'pullEntity').mockRejectedValue(new Error('nope'));
    renderWith(facade, <HomeScreen {...viewProps(facade)} />);

    fireEvent.click(await screen.findByTestId(`pull-${facade.ids.t103}`));
    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t) => t.kind === 'error')).toBe(true);
    });
  });

  it('attributes an agent’s in-flight work under its owning member', async () => {
    const facade = createFacade();
    renderWith(facade, <HomeScreen {...viewProps(facade)} />);

    const attrib = await screen.findByTestId(`attrib-${facade.ids.t104}`);
    // Forge (agent) shown alongside the member it works for.
    expect(within(attrib).getByLabelText(/Forge \(agent\)/)).toBeInTheDocument();
    expect(within(attrib).getByLabelText(/Forge works for Subhang/)).toBeInTheDocument();
  });

  it('opens an entity panel through the shell callback', async () => {
    const facade = createFacade();
    const onOpenEntity = vi.fn();
    renderWith(facade, <HomeScreen {...viewProps(facade, { onOpenEntity })} />);

    const row = await screen.findByTestId(`row-${facade.ids.t103}`);
    fireEvent.click(row.querySelector('.cv2-screenrow__cell') as HTMLElement);
    expect(onOpenEntity).toHaveBeenCalledWith(facade.ids.t103);
  });
});
