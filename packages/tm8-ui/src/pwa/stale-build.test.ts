import { describe, expect, it } from 'vitest';
import {
  STALE_BUILD_RELOAD_KEY,
  STALE_BUILD_RELOAD_WINDOW_MS,
  installStaleBuildRecovery,
} from './stale-build';

function harness(stamp: string | null = null) {
  const listeners: Array<() => void> = [];
  const store = new Map<string, string>();
  if (stamp !== null) store.set(STALE_BUILD_RELOAD_KEY, stamp);
  let reloads = 0;
  let clock = 1_000_000;
  const env = {
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'vite:preloadError') listeners.push(fn);
    },
    location: { reload: () => { reloads += 1; } },
  };
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  return {
    env,
    storage,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    fire: () => listeners.forEach((fn) => fn()),
    reloads: () => reloads,
  };
}

describe('stale-build recovery', () => {
  it('reloads once when a lazy chunk from an old build 404s', () => {
    const h = harness();
    installStaleBuildRecovery(h.env, h.storage, h.now);
    h.fire();
    expect(h.reloads()).toBe(1);
  });

  it('does not loop when the chunk is missing from the current build too', () => {
    const h = harness();
    installStaleBuildRecovery(h.env, h.storage, h.now);
    h.fire();
    h.advance(1_000);
    h.fire();
    expect(h.reloads()).toBe(1);
  });

  it('recovers again from a later deploy once the window has passed', () => {
    const h = harness(String(1_000_000 - STALE_BUILD_RELOAD_WINDOW_MS - 1));
    installStaleBuildRecovery(h.env, h.storage, h.now);
    h.fire();
    expect(h.reloads()).toBe(1);
  });

  it('never reloads without storage to guard the loop', () => {
    const h = harness();
    installStaleBuildRecovery(h.env, undefined, h.now);
    h.fire();
    expect(h.reloads()).toBe(0);
  });
});
