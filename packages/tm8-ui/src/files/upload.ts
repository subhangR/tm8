/**
 * THE ONE UPLOAD TASK, for every surface that uploads.
 *
 * PROVENANCE: this is `channel-screen/chat-attachments.ts` lifted verbatim —
 * same lifecycle, same cancellation semantics, same error vocabulary. It moved
 * because a SECOND caller appeared (the entity panel's attachment strip), and
 * the alternative to lifting was a copy. A copied grant lifecycle is the worst
 * possible duplication: the two copies would diverge on the abort path, which
 * is exactly the path nobody exercises by hand, so the divergence would be
 * invisible until it leaked grants in production.
 *
 * `chat-attachments.ts` is now a thin re-export that pins the chat's own
 * `uuidV7` mutation-id generator, so the composer's behaviour is unchanged.
 *
 * WHAT CHANGED IN THE LIFT, and why: the completion check was
 * `entity.state.kind !== 'file'`, a kind literal §15.2 fails this lane's build
 * on. It now discriminates STRUCTURALLY through `rowFromEntity`, which is this
 * lane's settled idiom for the same question (`model.ts`) and which is what the
 * caller wanted anyway — a row, not a discriminant.
 */
import type { EntityId, FileUploadGrant, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { rowFromEntity } from './model';

/** What a finished upload gives back. `maxSizeBytes` is the grant's MEASURED
 *  ceiling — the only place this deployment's real cap is knowable. */
export interface UploadedFile {
  fileEntityId: EntityId;
  name: string;
  mime: string;
  sizeBytes: number;
  maxSizeBytes: number;
}

export interface FileUploadTask {
  result: Promise<UploadedFile>;
  cancel(): void;
}

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'UploadCancelledError';
  }
}

export interface FileUploadTaskOptions {
  /** The seam's file group, by TYPE — this lane constructs no seam. */
  files: Seam['files'];
  file: File;
  spaceId: SpaceId | string;
  /** The entity the finished file is attached to, via an `attached_to` edge. */
  anchorId: EntityId;
  newMutationId?: () => string;
  checksum?: (file: Blob) => Promise<string>;
}

/**
 * Starts one canonical file operation. The task owns its grant and is the only
 * place allowed to abort it, which makes cancellation and failed PUT cleanup
 * idempotent even when they race.
 */
export function createFileUploadTask({
  files,
  file,
  spaceId,
  anchorId,
  newMutationId = defaultMutationId,
  checksum = sha256Hex,
}: FileUploadTaskOptions): FileUploadTask {
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
    throw new UploadCancelledError();
  };

  const result = (async (): Promise<UploadedFile> => {
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
      const row = entity ? rowFromEntity(entity) : null;
      if (!row) throw uploadError('invariant_violation', 'Upload completed without a file entity.');
      completed = true;
      return {
        fileEntityId: row.fileEntityId,
        name: row.name,
        mime: row.mime,
        sizeBytes: row.sizeBytes ?? file.size,
        maxSizeBytes: grant.maxSizeBytes,
      };
    } catch (error) {
      await abortGrant();
      if (cancelled && !(error instanceof UploadCancelledError)) {
        throw new UploadCancelledError();
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

/**
 * Only used when a caller supplies none. The chat lane passes its own `uuidV7`
 * (time-ordered ids matter to its journal); a panel upload has no journal to
 * order, so a v4 is enough and importing the chat store's module for one
 * function would be a real dependency for a cosmetic gain.
 */
function defaultMutationId(): string {
  return crypto.randomUUID();
}

const SAFE_UPLOAD_ERRORS: Readonly<Record<string, string>> = {
  payload_too_large: 'This file is larger than the allowed upload size.',
  forbidden: 'You do not have permission to upload this file.',
  unauthenticated: 'Sign in again before uploading files.',
  invalid_input: 'This file cannot be uploaded.',
};

/** Never surface transport paths, tokens, or arbitrary server prose. */
export function safeUploadReason(error: unknown): string {
  if (error instanceof UploadCancelledError) return 'Upload cancelled.';
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
  return code ? SAFE_UPLOAD_ERRORS[code] ?? 'Upload failed. Try again.' : 'Upload failed. Try again.';
}

function uploadError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
