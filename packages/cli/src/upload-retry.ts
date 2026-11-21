import { isRetryableUploadError, retryUpload } from '@tm8/contract';
import { ProtocolError, TransportError } from './errors.js';
import type { CommandContext } from './run.js';

export function canResumeUpload(error: unknown): boolean {
  return isRetryableUploadError(error) || error instanceof TransportError
    || (error instanceof ProtocolError && error.status !== undefined
      && ((error.status >= 200 && error.status < 300) || [408, 429, 502, 503, 504].includes(error.status)));
}

export function canResumeFileTransfer(error: unknown): boolean {
  return canResumeUpload(error) || (typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'conflict');
}

/** The caller must retain its original body, expected version and mutation ID. */
export function retryUploadStage<T>(cmd: CommandContext, stage: string, operation: () => Promise<T>, isRetryable = canResumeUpload): Promise<T> {
  return retryUpload(operation, {
    isRetryable,
    onRetry: (attempt, delayMs) => cmd.out.note(`${stage}: retry ${attempt}/4 in ${delayMs}ms`),
  });
}
