/**
 * Tasks — board by default, tree/board/select switching, the axis pivot
 * re-groups the board on ANY axis, and bulk ops apply to the whole selection
 * through the collection mutation helpers (merged axes, never replaced).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { TasksScreen, tasksViews } from '../../screens/tasks';
import { useNavStore } from '../../stores';
import { createFacade, renderWith, resetStores, viewProps } from './helpers';

function columnKeys(): string[] {
  return [...document.querySelectorAll('.cv2-board__col')]
    .map((el) => el.getAttribute('data-column') ?? '');
}

describe('TasksScreen', () => {
  beforeEach(() => { resetStores(); });

  it('registers itself as the `tasks` view', () => {
    expect(tasksViews.tasks).toBe(TasksScreen);
  });

  it('defaults to a Board grouped by workStatus', async () => {
    const facade = createFacade();
    renderWith(facade, <TasksScreen {...viewProps(facade, { view: 'tasks' })} />);

    await waitFor(() => expect(columnKeys().length).toBeGreaterThan(0));
    expect(columnKeys()).toEqual(expect.arrayContaining(['open', 'working', 'done']));
    expect(screen.getByTestId('tasks-mode-board')).toHaveAttribute('aria-selected', 'true');
  });

  it('re-groups the board when a manual axis pivot chip is picked', async () => {
    const facade = createFacade();
    renderWith(facade, <TasksScreen {...viewProps(facade, { view: 'tasks' })} />);

    await waitFor(() => expect(columnKeys()).toContain('open'));
    // `milestone` is a MANUAL axis — indistinguishable from the defaults here.
    fireEvent.click(await screen.findByRole('radio', { name: 'milestone' }));

    await waitFor(() => expect(columnKeys()).toEqual(
      expect.arrayContaining(['v2-alpha', 'v2-beta', 'ga']),
    ));
    expect(columnKeys()).not.toContain('open');
  });

  it('switches to the Tree layout', async () => {
    const facade = createFacade();
    renderWith(facade, <TasksScreen {...viewProps(facade, { view: 'tasks' })} />);

    await waitFor(() => expect(columnKeys().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId('tasks-mode-tree'));

    await waitFor(() => expect(columnKeys().length).toBe(0));
    expect(screen.getByTestId('tasks-mode-tree')).toHaveAttribute('aria-selected', 'true');
  });

  it('bulk-moves the whole selection on the active axis with a MERGED axes map', async () => {
    const facade = createFacade();
    const patch = vi.spyOn(facade, 'patchTask');
    renderWith(facade, <TasksScreen {...viewProps(facade, { view: 'tasks' })} />);

    fireEvent.click(await screen.findByRole('radio', { name: 'milestone' }));
    fireEvent.click(screen.getByTestId('tasks-mode-select'));

    const rowA = await screen.findByTestId(`row-${facade.ids.t104}`);
    const rowB = await screen.findByTestId(`row-${facade.ids.t105}`);
    fireEvent.click(rowA.querySelector('input[type="checkbox"]') as HTMLElement);
    fireEvent.click(rowB.querySelector('input[type="checkbox"]') as HTMLElement);

    expect(await screen.findByTestId('bulk-count')).toHaveTextContent('2 selected');
    fireEvent.click(await screen.findByTestId('bulk-to-ga'));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    for (const call of patch.mock.calls) {
      const axes = call[1].axes as Record<string, string>;
      expect(axes.milestone).toBe('ga');
      // the merge kept the untouched default axis
      expect(axes.type).toBeTruthy();
    }
    await waitFor(() => expect(useNavStore.getState().selection).toEqual([]));
  });

  it('select-all selects every loaded task and leaving select mode clears it', async () => {
    const facade = createFacade();
    renderWith(facade, <TasksScreen {...viewProps(facade, { view: 'tasks' })} />);

    fireEvent.click(screen.getByTestId('tasks-mode-select'));
    const selectAll = await screen.findByLabelText('Select all tasks');
    await waitFor(() => expect(screen.getByTestId('tasks-select').querySelectorAll('.cv2-screenrow').length)
      .toBeGreaterThan(1));

    fireEvent.click(selectAll);
    await waitFor(() => expect(useNavStore.getState().selection.length).toBeGreaterThan(1));

    fireEvent.click(screen.getByTestId('tasks-mode-board'));
    await waitFor(() => expect(useNavStore.getState().selection).toEqual([]));
  });
});
