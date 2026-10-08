// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SpaceId } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { useGateData } from './useGateData';

afterEach(cleanup);

it('refreshes the workspace menu after an admin save without reloading the app', async () => {
  const seam = createFixtureSeam();
  const { result } = renderHook(() => useGateData({ leftKind: 'task', rightKind: 'work_session', seam }));
  await waitFor(() => expect(result.current.ready).toBe(true));
  const settings = await seam.spaceSettings(result.current.spaceId);
  const menu = { ...result.current.menu.config, revision: 42 };
  vi.spyOn(seam, 'spaceSettings').mockResolvedValue({ ...settings, menu });
  act(() => result.current.refreshMenu());
  await waitFor(() => expect(result.current.menu.config.revision).toBe(42));
});

it('does not apply a delayed menu refresh after switching spaces', async () => {
  const seam = createFixtureSeam();
  const [home] = await seam.spaces();
  const other = '019f0000-0000-7000-8000-0000000000b0' as SpaceId;
  seam.spaces = async () => [home!, { ...home!, id: other, name: 'Other' }];
  const { result } = renderHook(() => useGateData({ leftKind: 'task', rightKind: 'work_session', seam }));
  await waitFor(() => expect(result.current.ready).toBe(true));
  const originalSpace = result.current.spaceId;
  const settings = await seam.spaceSettings(originalSpace);
  const menu = { ...result.current.menu.config, revision: 99 };
  const readSettings = seam.spaceSettings.bind(seam);
  let finish!: (value: typeof settings) => void;
  vi.spyOn(seam, 'spaceSettings').mockImplementation(space => space === originalSpace
    ? new Promise(resolve => { finish = resolve; }) : readSettings(space));
  const oldRefresh = result.current.refreshMenu;
  act(oldRefresh);
  act(() => result.current.selectSpace(other));
  await waitFor(() => expect(result.current.spaceId).toBe(other));
  await act(async () => finish({ ...settings, menu }));
  expect(result.current.menu.config.revision).not.toBe(99);
  vi.mocked(seam.spaceSettings).mockClear();
  act(oldRefresh);
  expect(seam.spaceSettings).not.toHaveBeenCalled();
});
