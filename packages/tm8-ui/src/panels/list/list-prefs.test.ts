// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/* The page-lifetime fallback is module state; each test gets a fresh page. */
async function load() {
  vi.resetModules();
  return (await import('./list-prefs')).useListPrefs;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('useListPrefs without working storage', () => {
  it('keeps a choice for the page when storage refuses reads and writes', async () => {
    const useListPrefs = await load();
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => useListPrefs('task'));
    act(() => result.current.setGroupBy('status'));
    expect(result.current.groupBy).toBe('status');
  });

  it('keeps a choice over the stale stored value when only the write fails', async () => {
    const useListPrefs = await load();
    window.localStorage.setItem('tm8.list.prefs.v1.task', JSON.stringify({ groupBy: 'priority', subItems: true }));
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const { result } = renderHook(() => useListPrefs('task'));
    expect(result.current.groupBy).toBe('priority');
    act(() => result.current.setSubItems(false));
    expect(result.current.subItems).toBe(false);
    expect(result.current.groupBy).toBe('priority');
  });
});
