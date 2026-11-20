/** Recovery policy for uploads whose caller keeps the payload and mutation ID. */
export const UPLOAD_MAX_ATTEMPTS = 4;
export const UPLOAD_MAX_RETRY_WAIT_MS = 30_000;

const PERMANENT = new Set([
  'invalid_input', 'forbidden', 'unauthenticated', 'not_found', 'not_implemented',
  'payload_too_large', 'limit_exceeded', 'quota_exceeded', 'version_conflict',
]);

export function isRetryableUploadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; retryable?: unknown };
  if (typeof e.code === 'string' && PERMANENT.has(e.code)) return false;
  if (e.retryable === false) return false;
  return e.retryable === true || e.code === 'upstream_unavailable' || e.code === 'rate_limited';
}

/** Only for the same immutable grant PUT: another writer may hold its lease. */
export function isRetryableFileTransferError(error: unknown): boolean {
  return isRetryableUploadError(error) || (typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'conflict');
}

export interface UploadRetryOptions {
  signal?: AbortSignal;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (nextAttempt: number, delayMs: number) => void;
  /** Injected by tests; production waits can be interrupted by cancellation. */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

function pause(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('Upload cancelled.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Only use for replay-safe operations; this helper never changes their inputs. */
export async function retryUpload<T>(operation: () => Promise<T>, options: UploadRetryOptions = {}): Promise<T> {
  const { signal, isRetryable = isRetryableUploadError, onRetry, sleep = pause, random = Math.random } = options;
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt >= UPLOAD_MAX_ATTEMPTS || !isRetryable(error)) throw error;
      const details = (error as { details?: { retryAfterMs?: unknown; retryAfterSeconds?: unknown } } | null)?.details;
      const milliseconds = details?.retryAfterMs;
      const seconds = details?.retryAfterSeconds;
      const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      const retryAfter = Math.max(valid(milliseconds) ? milliseconds : 0, valid(seconds) ? seconds * 1000 : 0);
      // A longer server instruction is a paused upload, never an early retry.
      if (retryAfter > UPLOAD_MAX_RETRY_WAIT_MS) throw error;
      const backoff = Math.round(Math.min(5_000, 500 * 2 ** (attempt - 1)) * (0.75 + random() * 0.5));
      const delayMs = Math.max(backoff, retryAfter);
      onRetry?.(attempt + 1, delayMs);
      await sleep(delayMs, signal);
    }
  }
}
