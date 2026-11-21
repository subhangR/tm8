import { describe, expect, it, vi } from 'vitest';
import { isRetryableUploadError, retryUpload } from '../src/upload-recovery.js';

describe('replay-safe upload recovery', () => {
  it('uses bounded exponential backoff and the same operation', async () => {
    const unavailable = { code: 'upstream_unavailable', retryable: true };
    const operation = vi.fn().mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable).mockResolvedValue('file');
    const sleep = vi.fn(async () => {});
    await expect(retryUpload(operation, { sleep, random: () => 0.5 })).resolves.toBe('file');
    expect(sleep.mock.calls).toEqual([[500, undefined], [1000, undefined]]);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('stops after four attempts and preserves the original failure', async () => {
    const error = { code: 'rate_limited', retryable: true };
    const operation = vi.fn().mockRejectedValue(error);
    await expect(retryUpload(operation, { sleep: async () => {} })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it.each(['invalid_input', 'forbidden', 'unauthenticated', 'payload_too_large', 'limit_exceeded', 'version_conflict'])('does not retry permanent %s even if flagged', async (code) => {
    const operation = vi.fn().mockRejectedValue({ code, retryable: true });
    await expect(retryUpload(operation)).rejects.toMatchObject({ code });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('respects server Retry-After and pauses when the wait exceeds its budget', async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn().mockRejectedValueOnce({ code: 'rate_limited', details: { retryAfterSeconds: 8 } }).mockResolvedValue(true);
    await retryUpload(operation, { sleep });
    expect(sleep).toHaveBeenCalledWith(8000, undefined);
    const error = { code: 'rate_limited', details: { retryAfterSeconds: 31 } };
    const held = vi.fn().mockRejectedValue(error);
    await expect(retryUpload(held, { sleep })).rejects.toBe(error);
    expect(held).toHaveBeenCalledTimes(1);
  });

  it('cancels backoff without another attempt', async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue({ code: 'upstream_unavailable' });
    const result = retryUpload(operation, { signal: controller.signal, onRetry: () => queueMicrotask(() => controller.abort()) });
    await expect(result).rejects.toHaveProperty('name', 'AbortError');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown errors and explicit non-retryable refusals out of recovery', () => {
    expect(isRetryableUploadError(new TypeError('programming error'))).toBe(false);
    expect(isRetryableUploadError({ code: 'upstream_unavailable', retryable: false })).toBe(false);
  });
});
