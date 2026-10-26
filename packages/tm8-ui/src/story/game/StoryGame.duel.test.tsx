// @vitest-environment jsdom
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { StoryGame } from './StoryGame';
import { STORY_FIXTURE } from '../fixture';
import { storyGameStore } from './store';
import type { SceneProps } from './scene';

vi.mock('./palette', async (original) => ({ ...await original<typeof import('./palette')>(), hasWebGL: () => true }));
vi.mock('./scene', () => ({ default: ({ world, onNear }: SceneProps) => {
  useEffect(() => { onNear(world.places.find((p) => p.root && p.encounters.some((e) => e.phase === 'active'))!.id); }, [world, onNear]);
  return <div data-testid="mock-world" />;
} }));
describe('encounter keyboard and focus', () => {
  beforeEach(() => storyGameStore.getState().resetAll());
  it('escapes from a focused duel control and restores map focus; hidden quests are inert', async () => {
    const { findByTestId, getByRole, getByTestId, queryByTestId } = render(<StoryGame view={STORY_FIXTURE} mode="game" onMode={vi.fn()} open={vi.fn()} />);
    await findByTestId('story-game-duel');
    // The lazy scene reports the encounter outside act; settle its passive effects before pressing keys.
    await act(async () => {});
    expect(getByRole('complementary', { name: 'Quest log', hidden: true }).hasAttribute('inert')).toBe(true);
    const open = getByRole('button', { name: /Open session/ }); open.focus();
    fireEvent.keyDown(open, { key: 'Escape' });
    expect(queryByTestId('story-game-duel')).toBeNull();
    expect(document.activeElement).toBe(getByTestId('story-game'));
    expect(getByRole('complementary', { name: 'Quest log' }).hasAttribute('inert')).toBe(false);
  });
  it('E opens the encountered session through the page port and Return to map restores focus', async () => {
    const open = vi.fn();
    const { findByTestId, getByTestId, getByRole } = render(<StoryGame view={STORY_FIXTURE} mode="game" onMode={vi.fn()} open={open} />);
    await findByTestId('story-game-duel');
    const session = STORY_FIXTURE.page.sessions.find((s) => s.live && s.taskIds.length)!;
    fireEvent.keyDown(getByTestId('story-game'), { key: 'e' });
    expect(open).toHaveBeenCalledWith(session.id);
    expect(storyGameStore.getState().saves[STORY_FIXTURE.id]!.visited).toContain(session.id);
    fireEvent.click(getByRole('button', { name: 'Return to map' }));
    expect(document.activeElement).toBe(getByTestId('story-game'));
  });
});
