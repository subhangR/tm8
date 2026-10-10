import { afterEach, expect, it, vi } from 'vitest';
import { ChatCleanupRetryQueue } from '../../src/chat/cleanup-retries.js';

afterEach(() => vi.useRealTimers());

it('coalesces the exact closure and retries after failure without overlapping', async () => {
  vi.useFakeTimers();
  const queue = new ChatCleanupRetryQueue();
  let finish!: () => void;
  const retry = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('private failure'))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  queue.schedule(retry); queue.schedule(retry);
  await vi.advanceTimersByTimeAsync(500);
  expect(retry).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(retry).toHaveBeenCalledTimes(2);
  queue.schedule(retry);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(retry).toHaveBeenCalledTimes(2);
  finish(); await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  queue.stop();
});

it('stops pending and failed in-flight retries when the server closes', async () => {
  vi.useFakeTimers();
  const queue = new ChatCleanupRetryQueue();
  let reject!: (error: Error) => void;
  const inFlight = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const pending = vi.fn(async () => undefined);
  queue.schedule(inFlight);
  await vi.advanceTimersByTimeAsync(500);
  queue.schedule(pending); queue.stop();
  reject(new Error('private failure')); await Promise.resolve();
  queue.schedule(pending);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(inFlight).toHaveBeenCalledTimes(1);
  expect(pending).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
