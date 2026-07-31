import type { EntityId, FileUploadGrant, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { uuidV7 } from './chat-mutations';

export interface UploadedChatAttachment {
  fileEntityId: EntityId;
  name: string;
  mime: string;
  sizeBytes: number;
  maxSizeBytes: number;
}

export interface ChatAttachmentUploadTask {
  result: Promise<UploadedChatAttachment>;
  cancel(): void;
}

export class ChatUploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'ChatUploadCancelledError';
  }
}

interface UploadTaskOptions {
  files: Seam['files'];
  file: File;
  spaceId: SpaceId | string;
  anchorId: EntityId;
  newMutationId?: () => string;
  checksum?: (file: Blob) => Promise<string>;
}

/**
 * Starts one canonical file operation. The task owns its grant and is the only
 * place allowed to abort it, which makes cancellation and failed PUT cleanup
 * idempotent even when they race.
 */
export function createChatAttachmentUploadTask({
  files,
  file,
  spaceId,
  anchorId,
  newMutationId = uuidV7,
  checksum = sha256Hex,
}: UploadTaskOptions): ChatAttachmentUploadTask {
  let cancelled = false;
  let completed = false;
  let grant: FileUploadGrant | null = null;
  let aborting: Promise<void> | null = null;

  const abortGrant = (): Promise<void> => {
    if (grant === null || completed) return Promise.resolve();
    aborting ??= files.abort(grant.uploadId, { clientMutationId: newMutationId() })
      .then(() => undefined)
      .catch(() => undefined);
    return aborting;
  };

  const assertActive = async (): Promise<void> => {
    if (!cancelled) return;
    await abortGrant();
    throw new ChatUploadCancelledError();
  };

  const result = (async (): Promise<UploadedChatAttachment> => {
    try {
      if (file.size <= 0) throw uploadError('invalid_input', 'Empty files cannot be uploaded.');
      const checksumSha256 = await checksum(file);
      await assertActive();
      grant = await files.uploadInit({
        clientMutationId: newMutationId(),
        spaceId,
        entityId: anchorId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        checksumSha256,
      });
      await assertActive();
      if (file.size > grant.maxSizeBytes) {
        throw uploadError('payload_too_large', 'This file exceeds the upload limit.');
      }
      await files.putBytes(grant, file);
      await assertActive();
      const response = await files.complete(grant.uploadId, { clientMutationId: newMutationId() });
      const entity = response.entity;
      if (!entity || entity.state.kind !== 'file') {
        throw uploadError('invariant_violation', 'Upload completed without a file entity.');
      }
      completed = true;
      return {
        fileEntityId: entity.id,
        name: entity.state.name,
        mime: entity.state.mimeType,
        sizeBytes: entity.state.sizeBytes,
        maxSizeBytes: grant.maxSizeBytes,
      };
    } catch (error) {
      await abortGrant();
      if (cancelled && !(error instanceof ChatUploadCancelledError)) {
        throw new ChatUploadCancelledError();
      }
      throw error;
    }
  })();

  return {
    result,
    cancel() {
      cancelled = true;
      void abortGrant();
    },
  };
}

export async function sha256Hex(blob: Blob): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw uploadError('upstream_unavailable', 'Secure file checksums are unavailable in this browser.');
  }
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const SAFE_UPLOAD_ERRORS: Readonly<Record<string, string>> = {
  payload_too_large: 'This file is larger than the allowed upload size.',
  forbidden: 'You do not have permission to upload this file.',
  unauthenticated: 'Sign in again before uploading files.',
  invalid_input: 'This file cannot be uploaded.',
};

/** Never surface transport paths, tokens, or arbitrary server prose. */
export function safeUploadReason(error: unknown): string {
  if (error instanceof ChatUploadCancelledError) return 'Upload cancelled.';
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
  return code ? SAFE_UPLOAD_ERRORS[code] ?? 'Upload failed. Try again.' : 'Upload failed. Try again.';
}

function uploadError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
