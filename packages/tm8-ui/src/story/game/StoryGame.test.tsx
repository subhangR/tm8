// @vitest-environment jsdom
/**
 * The game is another view of the story (task 01a107e7): [Story | Game] in
 * the lead switches the whole page, remembered per story. Without WebGL
 * (jsdom) the world is a list of places, and opening one hands the id to the
 * page's `open` port and marks it visited.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { StoryPage } from '../StoryPage';
import { STORY_FIXTURE } from '../fixture';
import { storyGameStore } from './store';

describe('StoryPage game view', () => {
  beforeEach(() => storyGameStore.getState().resetAll());

  it('opens on the story and switches to the game and back', () => {
    const { getByTestId, queryByTestId, getAllByRole } = render(<StoryPage view={STORY_FIXTURE} actions={{}} />);
    expect(queryByTestId('story-game')).toBeNull();
    expect(getByTestId('story-header')).toBeTruthy();

    fireEvent.click(getAllByRole('tab', { name: 'Game' })[0]!);
    expect(getByTestId('story-game')).toBeTruthy();
    expect(queryByTestId('story-header')).toBeNull();
    expect(getByTestId('story-page').querySelector('.sty-sections')).toBeNull();
    expect(storyGameStore.getState().mode[STORY_FIXTURE.id]).toBe('game');

    fireEvent.click(within(getByTestId('story-game')).getByRole('tab', { name: 'Story' }));
    expect(queryByTestId('story-game')).toBeNull();
    expect(getByTestId('story-header')).toBeTruthy();
  });

  it('opens a place through the page port and remembers the visit', () => {
    storyGameStore.getState().setMode(STORY_FIXTURE.id, 'game');
    const open = vi.fn();
    const { getByTestId } = render(<StoryPage view={STORY_FIXTURE} actions={{ open }} />);
    const flat = getByTestId('story-game-flat');
    const root = STORY_FIXTURE.page.roots[0]!;
    fireEvent.click(within(flat).getByRole('button', { name: new RegExp(root.title) }));
    expect(open).toHaveBeenCalledWith(root.id);
    expect(storyGameStore.getState().saves[STORY_FIXTURE.id]?.visited).toContain(root.id);
    expect(within(getByTestId('story-game')).getByText(/1 \/ \d+ found|2 \/ \d+ found/)).toBeTruthy();
  });
});
