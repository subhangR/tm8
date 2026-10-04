// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { StoryPage } from './StoryPage';
import { STORY_FIXTURE } from './fixture';
import { storyGameStore } from './game/store';

describe('Graph, Tree and Game views', () => {
  beforeEach(() => storyGameStore.getState().resetAll());

  it('preserves legacy Graph preferences and switches all three views by keyboard', () => {
    storyGameStore.getState().setMode(STORY_FIXTURE.id, 'story');
    const ui = render(<StoryPage view={STORY_FIXTURE} actions={{}} />);
    const tabs = within(ui.getByRole('tablist', { name: 'Story view' }));
    const graph = tabs.getByRole('tab', { name: 'Graph' });
    expect(graph.getAttribute('aria-selected')).toBe('true');
    expect(ui.getByLabelText('The graph')).toBeTruthy();
    graph.focus();
    fireEvent.keyDown(graph, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs.getByRole('tab', { name: 'Tree' }));
    expect(ui.getByRole('region', { name: 'In this story' })).toBeTruthy();
    expect(ui.queryByLabelText('The graph')).toBeNull();
    expect(ui.queryByTestId('story-game')).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(tabs.getByRole('tab', { name: 'Game' }));
    expect(ui.getByTestId('story-game')).toBeTruthy();
    expect(ui.queryByRole('region', { name: 'In this story' })).toBeNull();
    expect(ui.getByRole('tabpanel', { name: 'Game' }).id).toBe(graph.getAttribute('aria-controls'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(graph);
    expect(ui.getByLabelText('The graph')).toBeTruthy();
    expect(ui.queryByTestId('story-game')).toBeNull();
  });

  it('opens Tree entities beside the story and retains each story mode and game save', () => {
    const open = vi.fn();
    storyGameStore.getState().savePosition(STORY_FIXTURE.id, 8, 6);
    storyGameStore.getState().visit(STORY_FIXTURE.id, STORY_FIXTURE.page.roots[0]!.id);
    const save = storyGameStore.getState().saves[STORY_FIXTURE.id];
    const ui = render(<StoryPage view={STORY_FIXTURE} actions={{ open }} />);
    fireEvent.click(ui.getByRole('tab', { name: 'Tree', exact: true }));
    const tree = ui.getByRole('region', { name: 'In this story' });
    const title = tree.querySelector<HTMLButtonElement>('[data-tree-title]')!;
    fireEvent.click(title);
    expect(open).toHaveBeenCalledWith(title.dataset.treeTitle);
    ui.rerender(<StoryPage view={{ ...STORY_FIXTURE, id: 'another-story' }} actions={{ open }} />);
    expect(ui.getByRole('tab', { name: 'Graph', exact: true }).getAttribute('aria-selected')).toBe('true');
    ui.rerender(<StoryPage view={STORY_FIXTURE} actions={{ open }} />);
    expect(ui.getByRole('tab', { name: 'Tree', exact: true }).getAttribute('aria-selected')).toBe('true');
    expect(storyGameStore.getState().saves[STORY_FIXTURE.id]).toEqual(save);
  });

  it('keeps the route filter and exact launch subject in Tree', async () => {
    storyGameStore.getState().setMode(STORY_FIXTURE.id, 'tree');
    const set = vi.fn();
    const add = vi.fn().mockResolvedValue(undefined);
    const ui = render(<StoryPage view={STORY_FIXTURE} actions={{ add }}
      filterRoute={{ hops: 1, kinds: ['task'], set }} />);
    const kinds = within(ui.getByRole('tablist', { name: 'Entity kinds' }));
    expect(kinds.getByRole('tab', { name: /^Tasks/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(kinds.getByRole('tab', { name: /^All/ }));
    expect(set).toHaveBeenCalledWith(null, null);
    fireEvent.click(ui.getByRole('button', { name: '▷ Launch on story' }));
    const dialog = within(ui.getByRole('dialog', { name: 'Add anything' }));
    fireEvent.change(dialog.getByLabelText('What to add'), { target: { value: 'Review the story' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Spawn session', exact: true }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ intent: 'spawn', onId: STORY_FIXTURE.id, text: 'Review the story' })));
  });
});
