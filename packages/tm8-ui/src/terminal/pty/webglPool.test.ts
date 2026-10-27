// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

import { createWebglPool, type WebglAddonLike, type WebglPoolOptions } from './webglPool.js';

class FakeAddon implements WebglAddonLike {
  disposed = false;
  loseContext = vi.fn();
  /** Where the real addon keeps its context (see `contextOf`). */
  _renderer = { _gl: { getExtension: () => ({ loseContext: this.loseContext }) } };
  private lossListeners: Array<() => void> = [];
  onContextLoss(listener: () => void) {
    this.lossListeners.push(listener);
    return { dispose: () => { this.lossListeners = this.lossListeners.filter((l) => l !== listener); } };
  }
  dispose() { this.disposed = true; }
  fireContextLoss() { for (const l of [...this.lossListeners]) l(); }
}

/** Visibility is a set of shown ids; the "element" is just the id tag. */
function harness(options: WebglPoolOptions = {}) {
  const shown = new Set<string>();
  const addons: FakeAddon[] = [];
  const elements = new Map<HTMLElement, string>();
  const pool = createWebglPool({
    isSupported: () => true,
    createAddon: () => {
      const addon = new FakeAddon();
      addons.push(addon);
      return addon;
    },
    isVisible: (element) => (element ? shown.has(elements.get(element)!) : false),
    ...options,
  });
  const terms = new Map<string, { loadAddon: ReturnType<typeof vi.fn> }>();
  const add = (id: string) => {
    const element = document.createElement('div');
    elements.set(element, id);
    const term = { element, loadAddon: vi.fn() };
    terms.set(id, term);
    return pool.register(id, term as unknown as Terminal);
  };
  const show = (...ids: string[]) => {
    shown.clear();
    for (const id of ids) shown.add(id);
    pool.reconcile();
  };
  const accelerated = () => [...terms.keys()].filter((id) => pool.isAccelerated(id));
  return { pool, add, show, accelerated, addons, terms };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

afterEach(() => vi.restoreAllMocks());

describe('webglPool', () => {
  it('never holds more than the cap, evicting the least-recently-shown to DOM', () => {
    const h = harness({ cap: 8 });
    for (const id of ids(20)) h.add(id);
    // Show them one at a time, as tab switching would.
    for (const id of ids(20)) {
      h.show(id);
      expect(h.pool.stats().live).toBeLessThanOrEqual(8);
    }
    expect(h.accelerated()).toEqual(ids(20).slice(12));
    // Evicted addons were disposed AND their GL contexts released, so they
    // stop counting toward the browser's cap before garbage collection.
    expect(h.addons.filter((a) => !a.disposed)).toHaveLength(8);
    expect(h.addons.filter((a) => a.loseContext.mock.calls.length > 0)).toHaveLength(12);
    expect(h.addons).toHaveLength(20);
  });

  it('keeps MRU order: re-showing an old terminal protects it from eviction', () => {
    const h = harness({ cap: 3 });
    for (const id of ['a', 'b', 'c', 'd']) h.add(id);
    h.show('a'); h.show('b'); h.show('c');
    h.show('a'); // a is now most recent
    h.show('d'); // evicts b, the least recent
    expect(h.accelerated().sort()).toEqual(['a', 'c', 'd']);
  });

  it('does not acquire for hidden terminals, and re-acquires when shown again', () => {
    const h = harness({ cap: 2 });
    for (const id of ['a', 'b', 'c']) h.add(id);
    h.show();
    expect(h.pool.stats().live).toBe(0);
    h.show('a'); h.show('b'); h.show('c');
    expect(h.pool.isAccelerated('a')).toBe(false);
    h.show('a');
    expect(h.pool.isAccelerated('a')).toBe(true);
    expect(h.terms.get('a')!.loadAddon).toHaveBeenCalledTimes(2);
  });

  it('a hidden terminal inside the window keeps its context (no churn)', () => {
    const h = harness({ cap: 2 });
    h.add('a'); h.add('b');
    h.show('a'); h.show('b');
    expect(h.accelerated()).toEqual(['a', 'b']);
    expect(h.addons.every((a) => !a.disposed)).toBe(true);
  });

  it('context loss disposes, falls back to DOM, and retries on the next show', () => {
    const h = harness();
    h.add('a');
    h.show('a');
    const first = h.addons[0]!;
    first.fireContextLoss();
    expect(first.disposed).toBe(true);
    expect(h.pool.isAccelerated('a')).toBe(false);
    expect(h.pool.stats().contextLosses).toBe(1);
    // Still visible: no immediate re-acquire loop.
    h.show('a');
    expect(h.pool.isAccelerated('a')).toBe(false);
    // Hidden, then shown again: re-acquired with a fresh addon.
    h.show();
    h.show('a');
    expect(h.pool.isAccelerated('a')).toBe(true);
    expect(h.addons).toHaveLength(2);
  });

  it('gives up on a terminal after repeated context losses', () => {
    const h = harness();
    h.add('a');
    for (let i = 0; i < 3; i++) {
      h.show('a');
      h.addons.at(-1)!.fireContextLoss();
      h.show();
    }
    h.show('a');
    expect(h.pool.isAccelerated('a')).toBe(false);
    expect(h.addons).toHaveLength(3);
  });

  it('stays on DOM silently when WebGL is unsupported', () => {
    const createAddon = vi.fn(() => new FakeAddon());
    const h = harness({ isSupported: () => false, createAddon });
    h.add('a');
    h.show('a');
    expect(createAddon).not.toHaveBeenCalled();
    expect(h.pool.stats()).toMatchObject({ live: 0, supported: false });
  });

  it('a throwing activate disables WebGL page-wide and unloads the half-loaded addon', () => {
    const h = harness();
    h.add('a'); h.add('b');
    h.terms.get('a')!.loadAddon.mockImplementation(() => { throw new Error('WebGL2 not supported'); });
    h.show('a', 'b');
    expect(h.addons[0]!.disposed).toBe(true);
    expect(h.pool.stats()).toMatchObject({ live: 0, supported: false });
    expect(h.addons).toHaveLength(1);
  });

  it('unregister disposes the addon and frees the slot', () => {
    const h = harness({ cap: 1 });
    const offA = h.add('a');
    h.add('b');
    h.show('a', 'b');
    expect(h.pool.stats().live).toBe(1);
    offA();
    expect(h.addons[0]!.disposed).toBe(true);
    h.show('b');
    expect(h.pool.isAccelerated('b')).toBe(true);
  });
});
