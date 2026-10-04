// @vitest-environment jsdom
/**
 * The minimap's mount in the HUD (task 01a1090f): shown with WebGL, toggled
 * by N and by its button, never with the flat (no-WebGL) world. The 3D scene
 * is stubbed; jsdom cannot raise it.
 */
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { storyGameStore } from './store';

vi.mock('./scene', () => ({ default: () => null }));
vi.mock('./palette', async (actual) => ({ ...(await actual<typeof import('./palette')>()), hasWebGL: () => true }));

const { StoryGame } = await import('./StoryGame');

describe('StoryGame minimap', () => {
  beforeEach(() => {
    storyGameStore.getState().resetAll();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
  });

  it('shows by default and toggles with N and with the HUD button', async () => {
    const { getByTestId, getByRole } = render(<StoryGame view={STORY_FIXTURE} mode="game" onMode={() => {}} showModeSwitch={false} />);
    await act(async () => {});
    const game = getByTestId('story-game');
    const button = getByRole('button', { name: /minimap/i });
    expect(game.dataset.minimap).toBe('shown');
    expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(game, { key: 'n' });
    expect(game.dataset.minimap).toBe('hidden');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.keyDown(game, { key: 'N' });
    expect(game.dataset.minimap).toBe('shown');

    fireEvent.click(button);
    expect(game.dataset.minimap).toBe('hidden');
    expect(getByTestId('story-game-minimap').querySelector('canvas')!.hidden).toBe(true);
  });

  it('leaves M to the overview and WASD to walking', () => {
    const { getByTestId } = render(<StoryGame view={STORY_FIXTURE} mode="game" onMode={() => {}} showModeSwitch={false} />);
    const game = getByTestId('story-game');
    fireEvent.keyDown(game, { key: 'm' });
    fireEvent.keyDown(game, { key: 'w' });
    expect(game.dataset.minimap).toBe('shown');
  });
});
