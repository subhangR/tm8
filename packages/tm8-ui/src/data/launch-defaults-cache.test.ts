// @vitest-environment jsdom
/**
 * THE LAUNCH DEFAULTS CACHE — what the card can draw on its first frame, and
 * the rules that keep that photograph honest: only the node's own answers are
 * kept, one read per launch at a time, a reload keeps them, a sign-out drops
 * them, and the payload stays bounded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, LaunchDefaultsInput, LaunchDefaultsResult } from '@tm8/contract';

import { LAUNCH_DEFAULTS } from '../views/launch-fixtures';

type CacheModule = typeof import('./launch-defaults-cache');

/** A fresh copy of the module: what a page reload is to its in-tab memory. */
async function reloadModule(): Promise<CacheModule> {
  vi.resetModules();
  return import('./launch-defaults-cache');
}

const input = (teammate: string, subject = 'task-1'): LaunchDefaultsInput => ({
  teamMemberId: teammate as EntityId,
  subjectId: subject as EntityId,
  agentTool: 'claude-code',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let cache: CacheModule;
beforeEach(async () => {
  localStorage.clear();
  cache = await reloadModule();
});

describe('peek and the read', () => {
  it('peeks nothing before an answer, then the NODE’S answer once a read resolves', async () => {
    const read = vi.fn(async () => LAUNCH_DEFAULTS);
    const load = cache.launchDefaultsLoader(read, 'local', 'sp-1');
    expect(load.peek?.(input('tm-a'))).toBeNull();
    await expect(load(input('tm-a'))).resolves.toBe(LAUNCH_DEFAULTS);
    expect(load.peek?.(input('tm-a'))).toEqual(LAUNCH_DEFAULTS);
  });

  it('answers only the SAME question: another teammate, subject or harness is a miss', async () => {
    const load = cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-1');
    await load(input('tm-a'));
    expect(load.peek?.(input('tm-b'))).toBeNull();
    expect(load.peek?.(input('tm-a', 'task-2'))).toBeNull();
    expect(load.peek?.({ ...input('tm-a'), agentTool: 'codex' })).toBeNull();
    // Another space on the same node is another cache.
    expect(cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-2').peek?.(input('tm-a'))).toBeNull();
  });

  it('joins a read already in flight: two opens of one launch are one request', async () => {
    const gate = deferred<LaunchDefaultsResult>();
    const read = vi.fn(() => gate.promise);
    const load = cache.launchDefaultsLoader(read, 'local', 'sp-1');
    const first = load(input('tm-a'));
    const second = load(input('tm-a'));
    expect(read).toHaveBeenCalledTimes(1);
    gate.resolve(LAUNCH_DEFAULTS);
    await expect(Promise.all([first, second])).resolves.toEqual([LAUNCH_DEFAULTS, LAUNCH_DEFAULTS]);
    // Settled: the next call asks the node again — the cache never answers a call.
    await load(input('tm-a'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stores nothing for a failed read, and keeps the last answer it had', async () => {
    let fail = false;
    const load = cache.launchDefaultsLoader(async () => { if (fail) throw new Error('503'); return LAUNCH_DEFAULTS; }, 'local', 'sp-1');
    await load(input('tm-a'));
    fail = true;
    await expect(load(input('tm-a'))).rejects.toThrow('503');
    expect(load.peek?.(input('tm-a'))).toEqual(LAUNCH_DEFAULTS);
    await expect(load(input('tm-b'))).rejects.toThrow('503');
    expect(load.peek?.(input('tm-b'))).toBeNull();
  });
});

describe('across a reload', () => {
  it('a reloaded page peeks the answer this browser kept', async () => {
    await cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-1')(input('tm-a'));
    const reloaded = await reloadModule();
    expect(reloaded.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-1').peek?.(input('tm-a'))).toEqual(LAUNCH_DEFAULTS);
  });

  it('ignores a corrupt or wrong-shaped payload, and drops the corrupt one', async () => {
    const key = 'tm8.launch-defaults.v1.local.sp-1';
    localStorage.setItem(key, '{not json');
    const reloaded = await reloadModule();
    expect(reloaded.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-1').peek?.(input('tm-a'))).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();

    localStorage.setItem(key, JSON.stringify({ entries: [{ key: 'tm-a|task-1|claude-code|', result: { memories: { items: 'nope' } } }] }));
    const again = await reloadModule();
    expect(again.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-1').peek?.(input('tm-a'))).toBeNull();
  });

  it('stays bounded: past 24 launches the least recently answered is forgotten', async () => {
    const load = cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-1');
    for (let i = 0; i < 25; i += 1) await load(input(`tm-${String(i)}`));
    expect(load.peek?.(input('tm-0'))).toBeNull();
    expect(load.peek?.(input('tm-24'))).toEqual(LAUNCH_DEFAULTS);
    const stored = JSON.parse(localStorage.getItem('tm8.launch-defaults.v1.local.sp-1')!) as { entries: Array<{ key: string }> };
    expect(stored.entries).toHaveLength(24);
    expect(stored.entries[0]!.key).toBe('tm-24|task-1|claude-code|');
  });
});

describe('an explicit sign-out', () => {
  it('forgets every space of THAT node, in memory and in storage — and no other node', async () => {
    await cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-1')(input('tm-a'));
    await cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-2')(input('tm-a'));
    await cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'other_node', 'sp-1')(input('tm-a'));
    cache.clearLaunchDefaultsCache('local');
    expect(cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-1').peek?.(input('tm-a'))).toBeNull();
    expect(cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'local', 'sp-2').peek?.(input('tm-a'))).toBeNull();
    expect(localStorage.getItem('tm8.launch-defaults.v1.local.sp-1')).toBeNull();
    expect(cache.launchDefaultsLoader(async () => LAUNCH_DEFAULTS, 'other_node', 'sp-1').peek?.(input('tm-a'))).toEqual(LAUNCH_DEFAULTS);
  });
});
