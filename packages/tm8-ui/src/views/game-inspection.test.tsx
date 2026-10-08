// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../data/fixtures/seam-fixture';
import { createMemoryTarget } from '../routes';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import type { GameModeProps } from '../game/types';

const TASK = 'task-4f8c2a9e';
vi.mock('../game/GameMode', () => ({
  default: ({ onInspect }: GameModeProps) => {
    const [level, setLevel] = useState('Taskland');
    useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !event.defaultPrevented) setLevel('Space hub');
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);
    return <div data-testid="walking-map-boundary"><span>{level}</span>
      <button onClick={() => onInspect(TASK)}>Inspect map entity</button></div>;
  },
}));
beforeEach(() => { localStorage.clear(); resetNav(); screenStackStore.getState().clearAll(); });
afterEach(cleanup);

describe('Game inspection in the real shell', () => {
  it('loads the existing detail panel, retains Game, consumes first Escape and restores map focus', async () => {
    const seam = createFixtureSeam();
    const detail = await seam.entity(TASK);
    const readEntity = vi.spyOn(seam, 'entity');
    const router = createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/game`);
    const view = render(<GateApp seam={seam} routerTarget={router} />);
    const inspect = await view.findByRole('button', { name: 'Inspect map entity' });
    inspect.focus();
    fireEvent.click(inspect);
    const aside = await view.findByTestId('game-inspection');
    await within(aside).findByText(detail.title, { exact: true });
    expect(readEntity).toHaveBeenCalledWith(TASK);
    expect(router.getHash()).toBe(`#/s/${FIXTURE_SPACE_ID}/game`);
    expect(view.getByTestId('walking-map-boundary').textContent).toContain('Taskland');
    fireEvent.keyDown(window, { key: '/' });
    await view.findByTestId('command-palette');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('command-palette')).toBeNull());
    expect(view.getByTestId('game-inspection')).toBe(aside);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('game-inspection')).toBeNull());
    expect(view.getByTestId('walking-map-boundary').textContent).toContain('Taskland');
    expect(document.activeElement).toBe(inspect);
    fireEvent.keyDown(inspect, { key: 'Escape' });
    await waitFor(() => expect(view.getByTestId('walking-map-boundary').textContent).toContain('Space hub'));
    expect(router.getHash()).toBe(`#/s/${FIXTURE_SPACE_ID}/game`);
  });

  it('closes the palette before the map receives Escape', async () => {
    const router = createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/game`);
    const view = render(<GateApp seam={createFixtureSeam()} routerTarget={router} />);
    await view.findByTestId('walking-map-boundary');
    fireEvent.keyDown(window, { key: '/' });
    const palette = await view.findByTestId('command-palette');
    fireEvent.keyDown(palette.querySelector('input')!, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('command-palette')).toBeNull());
    expect(view.getByTestId('walking-map-boundary').textContent).toContain('Taskland');
    fireEvent.keyDown(window, { key: '/' });
    await view.findByTestId('command-palette');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('command-palette')).toBeNull());
    expect(view.getByTestId('walking-map-boundary').textContent).toContain('Taskland');
    expect(router.getHash()).toBe(`#/s/${FIXTURE_SPACE_ID}/game`);
  });
});
