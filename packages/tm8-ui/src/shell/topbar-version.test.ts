// @vitest-environment jsdom
/**
 * The in-app rollback flag. These are the claims the backup plan rests on, and
 * every one of them is about a FAILURE mode — a browser that refuses storage,
 * a link handed round, a value nobody recognises — because those are the states
 * an escape hatch is used in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTopBarVersion, topBarVersion, TOPBAR_VERSION_KEY } from './topbar-version';

const setSearch = (search: string) => {
  window.history.replaceState({}, '', `/${search}`);
};

describe('topBarVersion', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setSearch('');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    setSearch('');
  });

  it('defaults to the current bar when nothing says otherwise', () => {
    expect(topBarVersion()).toBe('current');
  });

  it('honours a stored preference', () => {
    window.localStorage.setItem(TOPBAR_VERSION_KEY, 'legacy');
    expect(topBarVersion()).toBe('legacy');
  });

  it('the URL wins over storage — the support path works on a pinned device', () => {
    window.localStorage.setItem(TOPBAR_VERSION_KEY, 'legacy');
    setSearch('?topbar=current');
    expect(topBarVersion()).toBe('current');
  });

  it('the URL does NOT persist — a shared link must not re-pin every device that opens it', () => {
    setSearch('?topbar=legacy');
    expect(topBarVersion()).toBe('legacy');
    expect(window.localStorage.getItem(TOPBAR_VERSION_KEY)).toBeNull();
  });

  it('an unrecognised value means the current bar, never a third state', () => {
    window.localStorage.setItem(TOPBAR_VERSION_KEY, 'astryx');
    expect(topBarVersion()).toBe('current');
    setSearch('?topbar=banana');
    expect(topBarVersion()).toBe('current');
  });

  /* Safari private mode and some embedded webviews THROW on storage access
     rather than returning null. Stranding somebody on the old bar because
     their browser refused a read would be the worst possible failure for a
     control whose entire job is getting back. */
  it('a storage that throws means the current bar, not a crash', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(topBarVersion()).toBe('current');
  });

  it('a storage that throws on write does not throw at the caller', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setTopBarVersion('legacy')).not.toThrow();
  });

  /* Writing `current` REMOVES the key rather than storing it, so a device that
     opted back in is indistinguishable from one that never opted out. */
  it('opting back in clears the key rather than storing a second value', () => {
    setTopBarVersion('legacy');
    expect(window.localStorage.getItem(TOPBAR_VERSION_KEY)).toBe('legacy');
    setTopBarVersion('current');
    expect(window.localStorage.getItem(TOPBAR_VERSION_KEY)).toBeNull();
    expect(topBarVersion()).toBe('current');
  });
});
