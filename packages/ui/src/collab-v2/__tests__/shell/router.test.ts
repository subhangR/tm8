/**
 * L3 gate G1 — URL is the layout: encode/decode round-trips (stack + pins +
 * tabs), a deep link reproduces the full arrangement, and browser back/forward
 * walks the browsing history one navigation at a time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PINNED, useNavStore } from '../../stores/nav';
import { buildHash, createMemoryTarget, isRoutableHash, startRouter } from '../../shell/router';

const nav = () => useNavStore.getState();

beforeEach(() => { nav().reset(); });

describe('hash codec round-trip', () => {
  it('round-trips a view route with stack, pins and tabs', () => {
    nav().setSpace('space-1');
    nav().setView('tasks');
    nav().pushPanel({ entityId: 'T-100' });
    nav().pushPanel({ entityId: 'T-103' });
    nav().setPanelTab('T-103', 'connections');
    nav().pinPanel('T-100');

    const hash = nav().toHash();
    expect(hash).toContain('#/s/space-1/tasks');
    expect(hash).toContain('p=T-103');
    expect(hash).toContain('pin=T-100');

    const before = { view: nav().view, stack: nav().stack, pinned: nav().pinned };
    nav().reset();
    expect(nav().spaceId).toBeNull();

    nav().hydrateFromHash(hash);
    expect(nav().spaceId).toBe('space-1');
    expect(nav().view).toBe(before.view);
    expect(nav().stack).toEqual(before.stack);
    expect(nav().pinned).toEqual(before.pinned);
    expect(nav().toHash()).toBe(hash);
  });

  it('round-trips an entity Z4 route', () => {
    nav().setSpace('space-1');
    nav().setView('entity', 'doc-9');
    nav().pushPanel({ entityId: 'T-1' });
    const hash = nav().toHash();
    expect(hash.startsWith('#/s/space-1/e/doc-9')).toBe(true);

    nav().reset();
    nav().hydrateFromHash(hash);
    expect(nav().view).toBe('entity');
    expect(nav().entityId).toBe('doc-9');
    expect(nav().stack.map((r) => r.entityId)).toEqual(['T-1']);
  });

  it('escapes ids that need it', () => {
    nav().setSpace('sp ace/1');
    nav().pushPanel({ entityId: 'a?b=c' });
    const hash = nav().toHash();
    nav().reset();
    nav().hydrateFromHash(hash);
    expect(nav().spaceId).toBe('sp ace/1');
    expect(nav().stack.map((r) => r.entityId)).toEqual(['a?b=c']);
  });

  it('classifies routable hashes', () => {
    expect(isRoutableHash('#/s/space-1/home')).toBe(true);
    expect(isRoutableHash('#/s/space-1/e/x?p=y')).toBe(true);
    expect(isRoutableHash('#/')).toBe(false);
    expect(isRoutableHash('')).toBe(false);
  });

  it('buildHash matches the store codec', () => {
    nav().setSpace('space-1');
    nav().setView('docs');
    nav().pushPanel({ entityId: 'd1' });
    nav().pushPanel({ entityId: 'd2' });
    expect(buildHash({ spaceId: 'space-1', view: 'docs', stack: ['d1', 'd2'] })).toBe(nav().toHash());
  });
});

describe('deep link reproduces the layout', () => {
  it('hydrates space, view, stack and pins from the initial hash', () => {
    const target = createMemoryTarget('#/s/space-1/tasks?p=T-1.T-2&pin=D-1&t=T-2:discussion');
    const stop = startRouter(target);

    expect(nav().spaceId).toBe('space-1');
    expect(nav().view).toBe('tasks');
    expect(nav().stack).toEqual([{ entityId: 'T-1' }, { entityId: 'T-2', tab: 'discussion' }]);
    expect(nav().pinned).toEqual([{ entityId: 'D-1' }]);
    stop();
  });

  it('normalizes pins beyond the split cap in place (no extra history entry)', () => {
    const overflow = ['P1', 'P2', 'P3', 'P4', 'P5'].slice(0, MAX_PINNED + 2).join('.');
    const target = createMemoryTarget(`#/s/space-1/home?pin=${overflow}`);
    const stop = startRouter(target);

    expect(nav().pinned).toHaveLength(MAX_PINNED);
    expect(target.entries).toHaveLength(1);
    expect(target.getHash()).toBe(nav().toHash());
    stop();
  });

  it('publishes the store state when the initial hash carries no route', () => {
    nav().setSpace('space-1');
    const target = createMemoryTarget('#/');
    const stop = startRouter(target);
    expect(target.getHash()).toBe('#/s/space-1/home');
    expect(target.entries).toHaveLength(1);
    stop();
  });
});

describe('back/forward walks the browsing history', () => {
  it('pushes one entry per navigation and rewinds it', () => {
    const target = createMemoryTarget('#/s/space-1/home');
    const stop = startRouter(target);

    nav().setView('tasks');
    nav().pushPanel({ entityId: 'T-1' });
    nav().pushPanel({ entityId: 'T-2' });

    expect(target.entries).toEqual([
      '#/s/space-1/home',
      '#/s/space-1/tasks',
      '#/s/space-1/tasks?p=T-1',
      '#/s/space-1/tasks?p=T-1.T-2',
    ]);

    target.back();
    expect(nav().stack.map((r) => r.entityId)).toEqual(['T-1']);
    target.back();
    expect(nav().stack).toEqual([]);
    expect(nav().view).toBe('tasks');
    target.back();
    expect(nav().view).toBe('home');
    expect(target.canGoBack()).toBe(false);

    target.forward();
    expect(nav().view).toBe('tasks');
    target.forward();
    expect(nav().stack.map((r) => r.entityId)).toEqual(['T-1']);
    stop();
  });

  it('pinning and promoting are history entries (promote leaves a back target)', () => {
    const target = createMemoryTarget('#/s/space-1/tasks');
    const stop = startRouter(target);

    nav().pushPanel({ entityId: 'T-9' });
    nav().pinPanel('T-9');
    expect(target.getHash()).toBe('#/s/space-1/tasks?pin=T-9');

    nav().pushPanel({ entityId: 'D-4' });
    nav().promotePanel('D-4');
    expect(nav().view).toBe('entity');
    expect(nav().entityId).toBe('D-4');
    expect(target.getHash()).toBe('#/s/space-1/e/D-4?pin=T-9');

    // The center view we promoted from is exactly one step back.
    target.back();
    expect(nav().view).toBe('tasks');
    expect(nav().stack.map((r) => r.entityId)).toEqual(['D-4']);
    stop();
  });

  it('does not push history for non-addressable state (palette, selection)', () => {
    const target = createMemoryTarget('#/s/space-1/home');
    const stop = startRouter(target);
    const before = target.entries.length;

    nav().togglePalette();
    nav().setSelection(['a', 'b']);
    nav().toggleSelected('c');

    expect(target.entries).toHaveLength(before);
    stop();
  });

  it('stops syncing after teardown', () => {
    const target = createMemoryTarget('#/s/space-1/home');
    const stop = startRouter(target);
    stop();
    nav().setView('graph');
    expect(target.getHash()).toBe('#/s/space-1/home');
  });
});
