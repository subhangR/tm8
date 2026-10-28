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

  it('hands every answer to onAnswer, and never a failure — which the caller sees and nobody keeps', async () => {
    let fail = true;
    const onAnswer = vi.fn();
    const shared = sharedRead(async (key: string) => { if (fail) throw new Error('503'); return `ok ${key}`; }, (key) => key, { freshForMs: 60_000, onAnswer, now: () => 0 });
    await expect(shared('a')).rejects.toThrow('503');
    expect(onAnswer).not.toHaveBeenCalled();
    fail = false;
    await expect(shared('a')).resolves.toBe('ok a');
    expect(onAnswer).toHaveBeenCalledWith('a', 'ok a');
  });
});
