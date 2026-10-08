// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../data/fixtures/seam-fixture';
import { createMemoryTarget } from '../routes';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { GAME_PLACE, readLastTarget, writeLastTarget } from './last-place';

// Shell tests isolate its map boundary; GameScreen/real GameMode have separate tests.
vi.mock('./GameScreen', () => ({
  GameScreen: ({ memberId, data }: { memberId: string; data: { spaceId: string } }) =>
    <div data-testid="game-screen" data-member={memberId} data-space={data.spaceId}>Game map boundary</div>,
}));

beforeEach(() => {
  localStorage.clear();
  resetNav();
  screenStackStore.getState().clearAll();
});
afterEach(cleanup);
const at = (path: string) => createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}${path}`);

describe('Game in the application shell', () => {
  it('loads the canonical Game address without a Work redirect', async () => {
    const router = at('/game');
    const view = render(<GateApp seam={createFixtureSeam()} routerTarget={router} />);
    await view.findByTestId('game-screen');
    expect(router.getHash()).toBe(`#/s/${FIXTURE_SPACE_ID}/game`);
    expect(view.queryByTestId('tab-workspace')).toBeNull();
    expect(view.queryByTestId('unrouted-target')).toBeNull();
    expect(view.getByTestId('game-screen').getAttribute('data-member')).toBeTruthy();
  });

  it('opens Game from Work selector and browser back/forward retain their modes', async () => {
    const router = at('/work');
    const view = render(<GateApp seam={createFixtureSeam()} routerTarget={router} />);
    fireEvent.click(await view.findByTestId('tws-view-select'));
    fireEvent.click(within(view.getByRole('menu', { name: 'Views' })).getByRole('menuitemradio', { name: 'Game' }));
    await view.findByTestId('game-screen');
    expect(router.getHash()).toBe(`#/s/${FIXTURE_SPACE_ID}/game`);
    router.back();
    await view.findByTestId('tab-workspace');
    router.forward();
    await view.findByTestId('game-screen');
    expect(router.getHash()).toBe(`#/s/${FIXTURE_SPACE_ID}/game`);
  });

  it('offers Game in the palette and navigates to its canonical route', async () => {
    const router = at('/graph');
    const view = render(<GateApp seam={createFixtureSeam()} routerTarget={router} />);
    await view.findByRole('tablist', { name: 'Screens' });
    fireEvent.keyDown(window, { key: '/' });
    const palette = await view.findByTestId('command-palette');
    fireEvent.change(palette.querySelector('input')!, { target: { value: 'Game' } });
    const row = await waitFor(() => within(palette).getByText('Game', { exact: true }));
    fireEvent.click(row);
    await view.findByTestId('game-screen');
    expect(router.getHash()).toBe(`#/s/${FIXTURE_SPACE_ID}/game`);
  });

  it('remembers Game as a route-only mode and restores it without a boot address', async () => {
    writeLastTarget('local', FIXTURE_SPACE_ID, GAME_PLACE);
    const router = createMemoryTarget('#/');
    const view = render(<GateApp seam={createFixtureSeam()} routerTarget={router} />);
    await view.findByTestId('game-screen');
    expect(router.getHash()).toBe(`#/s/${FIXTURE_SPACE_ID}/game`);
    expect(readLastTarget('local', FIXTURE_SPACE_ID)).toEqual(GAME_PLACE);
  });
});
