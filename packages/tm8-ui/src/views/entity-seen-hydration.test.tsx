// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { SpaceId } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { createMemoryTarget } from '../routes';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { GateApp } from './GateApp';

vi.mock('../shell/desktop-modes', () => ({ desktopModes: () => 'legacy' }));

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '';
  resetNav();
  screenStackStore.getState().clearAll();
});
afterEach(cleanup);

it('keeps the ready shell and its open list menu when the deferred viewer actor arrives', async () => {
  const fixture = createFixtureSeam();
  const identity = await fixture.identity();
  let finish!: (value: typeof identity) => void;
  const pending = new Promise<typeof identity>((resolve) => { finish = resolve; });
  const identityRead = vi.fn(() => pending);
  const view = render(<GateApp seam={{ ...fixture, identity: identityRead }}
    routerTarget={createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/workspace`)} />);
  const grid = await view.findByTestId('workspace-grid');
  await waitFor(() => expect(identityRead).toHaveBeenCalled());
  const root = view.container.querySelector('.cv2-root');
  const left = within(grid).getByLabelText('Left panel');
  fireEvent.click(within(left).getByLabelText('Choose which list to show'));
  const menu = within(left).getByRole('menu', { name: 'Entity lists' });

  await act(async () => finish(identity));

  // #1122 keyed the entire shell on this deferred actor, discarding menus,
  // detail state and drafts after readiness. Preserve both DOM and state.
  expect(view.container.querySelector('.cv2-root')).toBe(root);
  expect(view.getByTestId('workspace-grid')).toBe(grid);
  expect(within(left).getByRole('menu', { name: 'Entity lists' })).toBe(menu);
});

it('still remounts the shell and closes its list menu when the space changes', async () => {
  const fixture = createFixtureSeam();
  const settings = await fixture.spaceSettings(FIXTURE_SPACE_ID);
  const identity = await fixture.identity();
  const otherSpace = 'sp-other' as SpaceId;
  const target = createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/workspace`);
  const seam = {
    ...fixture,
    spaces: async () => [settings.space, { ...settings.space, id: otherSpace, name: 'Other space' }],
    spaceSettings: async (spaceId: SpaceId) => ({ ...settings, space: {
      ...settings.space, id: spaceId, name: spaceId === otherSpace ? 'Other space' : settings.space.name,
    } }),
    identity: async () => ({ ...identity, memberships: [
      ...identity.memberships,
      { ...identity.memberships[0]!, spaceId: otherSpace },
    ] }),
  };
  const view = render(<GateApp seam={seam} routerTarget={target} />);
  const grid = await view.findByTestId('workspace-grid');
  const root = view.container.querySelector('.cv2-root');
  const left = within(grid).getByLabelText('Left panel');
  fireEvent.click(within(left).getByLabelText('Choose which list to show'));
  expect(within(left).getByRole('menu', { name: 'Entity lists' })).toBeTruthy();

  fireEvent.click(within(view.getByTestId('space-switcher')).getByRole('button'));
  fireEvent.click(within(view.getByRole('dialog', { name: 'Switch server or space' }))
    .getByRole('button', { name: 'Other space' }));

  // The existing McpProvider space key still resets the shell for a new
  // space; removing the actor key must preserve this older boundary.
  await waitFor(() => expect(view.container.querySelector('.cv2-root')).not.toBe(root));
  await view.findByTestId('workspace-grid');
  expect(view.getByTestId('workspace-grid')).not.toBe(grid);
  expect(view.queryByRole('menu', { name: 'Entity lists' })).toBeNull();
});
