/**
 * THE SHARED READ — one request per key at a time, an answer reused only
 * while fresh and only when it may be, a failure never reused.
 */
import { describe, expect, it, vi } from 'vitest';

import { sharedRead } from './shared-read';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('sharedRead', () => {
  it('joins a read in flight for the same key, and only that key', async () => {
    const gate = deferred<string>();
    const read = vi.fn((key: string) => (key === 'a' ? gate.promise : Promise.resolve(`fresh ${key}`)));
    const shared = sharedRead(read, (key) => key);
    const first = shared('a');
    const second = shared('a');
    await expect(shared('b')).resolves.toBe('fresh b');
    expect(read).toHaveBeenCalledTimes(2);
    gate.resolve('answer a');
    await expect(Promise.all([first, second])).resolves.toEqual(['answer a', 'answer a']);
  });

  it('with no freshness window, every settled call asks again', async () => {
    const read = vi.fn(async () => 'x');
    const shared = sharedRead(read, () => 'k');
    await shared(undefined);
    await shared(undefined);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reuses an answer inside its window and asks again after it', async () => {
    let clock = 1_000;
    const read = vi.fn(async () => `read at ${String(clock)}`);
    const shared = sharedRead(read, () => 'k', { freshForMs: 30_000, now: () => clock });
    await expect(shared(undefined)).resolves.toBe('read at 1000');
    clock += 29_999;
    await expect(shared(undefined)).resolves.toBe('read at 1000');
    expect(read).toHaveBeenCalledTimes(1);
    clock += 1;
    await expect(shared(undefined)).resolves.toBe('read at 31000');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reuses a kept answer; a later refused one replaces it and is asked for again', async () => {
    let clock = 0;
    const answers = ['usable', 'none', 'none'];
    const read = vi.fn(async () => answers.shift()!);
    const shared = sharedRead(read, () => 'k', { freshForMs: 60_000, keep: (a) => a === 'usable', now: () => clock });
    await expect(shared(undefined)).resolves.toBe('usable');
    await expect(shared(undefined)).resolves.toBe('usable');
    expect(read).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await expect(shared(undefined)).resolves.toBe('none');
    clock = 60_001;
    await expect(shared(undefined)).resolves.toBe('none');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('a refused answer is asked for again on every call', async () => {
    const read = vi.fn(async () => 'none');
    const shared = sharedRead(read, () => 'k', { freshForMs: 60_000, keep: (a) => a === 'usable', now: () => 0 });
    await shared(undefined);
    await shared(undefined);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failure — the caller sees it, and the next call asks again', async () => {
    let fail = true;
    const read = vi.fn(async (key: string) => { if (fail) throw new Error('503'); return `ok ${key}`; });
    const shared = sharedRead(read, (key) => key, { freshForMs: 60_000, now: () => 0 });
    await expect(shared('a')).rejects.toThrow('503');
    fail = false;
    await expect(shared('a')).resolves.toBe('ok a');
    await expect(shared('a')).resolves.toBe('ok a');
    expect(read).toHaveBeenCalledTimes(2);
  });

  describe('forget — an explicit change, not an age', () => {
    it('drops a kept answer inside its window: the next call asks', async () => {
      const read = vi.fn(async (key: string) => `answer ${key} #${String(read.mock.calls.length)}`);
      const shared = sharedRead(read, (key) => key, { freshForMs: 60_000, now: () => 0 });
      await expect(shared('a')).resolves.toBe('answer a #1');
      await expect(shared('b')).resolves.toBe('answer b #2');
      shared.forget('a');
      await expect(shared('a')).resolves.toBe('answer a #3');
      // Only the forgotten key: `b` is still reused.
      await expect(shared('b')).resolves.toBe('answer b #2');
      expect(read).toHaveBeenCalledTimes(3);
    });

    it('a read in flight across a forget is neither joined nor kept — it may describe the world before the change', async () => {
      const stale = deferred<string>();
      const fresh = deferred<string>();
      const read = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
      const shared = sharedRead(read as (key: string) => Promise<string>, (key) => key, { freshForMs: 60_000, now: () => 0 });
      const before = shared('a');
      shared.forget('a');
      const after = shared('a');
      const joined = shared('a');
      expect(read).toHaveBeenCalledTimes(2);
      // The stale answer lands first: its caller gets it, nobody keeps it, and
      // the fresh request in flight is still the one later calls join.
      stale.resolve('connected');
      await expect(before).resolves.toBe('connected');
      expect(shared('a')).toBe(after);
      fresh.resolve('revoked');
      await expect(Promise.all([after, joined])).resolves.toEqual(['revoked', 'revoked']);
      await expect(shared('a')).resolves.toBe('revoked');
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('forgetAll does it for every key', async () => {
      const read = vi.fn(async (key: string) => `answer ${key}`);
      const shared = sharedRead(read, (key) => key, { freshForMs: 60_000, now: () => 0 });
      await shared('a');
      await shared('b');
      shared.forgetAll();
      await shared('a');
      await shared('b');
      expect(read).toHaveBeenCalledTimes(4);
    });
  });

  describe('peek — the first-frame seed', () => {
    it('answers the last kept answer whatever its age, without asking', async () => {
      let clock = 0;
      const read = vi.fn(async (key: string) => `answer ${key}`);
      const shared = sharedRead(read, (key) => key, { now: () => clock });
      expect(shared.peek('a')).toBeNull();
      await shared('a');
      clock = 10 * 60_000;
      expect(shared.peek('a')).toBe('answer a');
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('falls back to the seed while nothing is kept, and prefers what was kept once there is', async () => {
      const shared = sharedRead(async (key: string) => `fresh ${key}`, (key) => key, { seed: (key) => (key === 'a' ? 'stored a' : null) });
      expect(shared.peek('a')).toBe('stored a');
      expect(shared.peek('b')).toBeNull();
      await shared('a');
      expect(shared.peek('a')).toBe('fresh a');
    });

    it('never peeks an answer keep refused, and forget leaves only the seed', async () => {
      const shared = sharedRead(async (key: string) => key, (key) => key, { keep: (a) => a !== 'b', seed: () => 'seed' });
      await shared('a');
      await shared('b');
      expect(shared.peek('a')).toBe('a');
      expect(shared.peek('b')).toBe('seed');
      shared.forget('a');
      expect(shared.peek('a')).toBe('seed');
    });

    it('keeps at most maxKept answers, the least recently answered going first', async () => {
      const shared = sharedRead(async (key: string) => key, (key) => key, { maxKept: 2 });
      await shared('a');
      await shared('b');
      await shared('a');
      await shared('c');
      expect(shared.peek('b')).toBeNull();
      expect(shared.peek('a')).toBe('a');
      expect(shared.peek('c')).toBe('c');
    });
  });
});
