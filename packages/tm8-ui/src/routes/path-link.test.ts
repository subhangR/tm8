// @vitest-environment jsdom
/**
 * `https://tm8.sh/e/{id}` — the PATH spelling of an entity link. The node
 * serves `index.html` for it, but the router reads only the hash, so it used to
 * boot with none and land on last-place: a list, with the item never opened.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserTarget, hashOfPathLink } from './transport';
import { redirect } from '@tm8/client-core/routes';

describe('hashOfPathLink', () => {
  it('respells /e/{id} and /s/{space}/e/{id} as their hash routes', () => {
    expect(hashOfPathLink('/e/01a154f2-aaac')).toBe('#/e/01a154f2-aaac');
    expect(hashOfPathLink('/e/01a154f2-aaac/')).toBe('#/e/01a154f2-aaac');
    expect(hashOfPathLink('/s/sp-1/e/doc-1')).toBe('#/s/sp-1/e/doc-1');
  });

  it('is null for every other path', () => {
    for (const path of ['/', '', '/e/', '/e', '/join/abc', '/e/a/b', '/x/e/a', '/mcp/oauth/callback']) {
      expect(hashOfPathLink(path)).toBeNull();
    }
  });

  it('the bare form lands in the last-active space', () => {
    expect(redirect(hashOfPathLink('/e/doc-1')!, { lastActiveSpaceId: 'sp-1' })).toEqual({ hash: '#/s/sp-1/e/doc-1' });
  });
});

describe('createBrowserTarget reads a path link', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('moves /e/{id} into the hash, in place, keeping the query', () => {
    window.history.replaceState(null, '', '/e/doc-1?x=1');
    const before = window.history.length;
    const target = createBrowserTarget();
    expect(target.getHash()).toBe('#/e/doc-1');
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?x=1');
    expect(window.history.length).toBe(before);
  });

  it('leaves a link that already has a hash alone', () => {
    window.history.replaceState(null, '', '/e/doc-1#/s/sp-1/k/tasks');
    expect(createBrowserTarget().getHash()).toBe('#/s/sp-1/k/tasks');
    expect(window.location.pathname).toBe('/e/doc-1');
  });

  it('touches nothing on an ordinary boot', () => {
    window.history.replaceState(null, '', '/join/abc');
    createBrowserTarget();
    expect(window.location.pathname).toBe('/join/abc');
    expect(window.location.hash).toBe('');
  });
});
