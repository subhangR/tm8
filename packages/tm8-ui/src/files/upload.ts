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
import type { CommandResult, EntityId, FileUploadGrant, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { rowFromEntity } from './model';
import { sha256HexOfBytes } from './sha256';

/** What a finished upload gives back. `maxSizeBytes` is the grant's MEASURED
 *  ceiling — the only place this deployment's real cap is knowable. */
export interface UploadedFile {
  fileEntityId: EntityId;
  name: string;
  mime: string;
  sizeBytes: number;
  maxSizeBytes: number;
  /**
   * The completion's own `CommandResult`, carried rather than discarded.
   *
   * A caller that creates an entity this way must reconcile it into the store,
   * and the only alternative was fabricating `{patches: []}` — which tells the
   * store nothing, and then leaves the caller selecting an id the store has
   * never been told about.
   */
  result: CommandResult;
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
  /**
   * The entity the finished file is attached to, via an `attached_to` edge.
   * OPTIONAL since 2026-08-10 (files-explorer lane): `FileUploadInitInput.entityId`
   * has always been optional on the contract — an anchor-less upload lands in
   * the space library attached to nothing, which is exactly what the Files
   * explorer's Library root means. Additive; every existing caller passes one.
   */
  anchorId?: EntityId;
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
        ...(anchorId !== undefined ? { entityId: anchorId } : {}),
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
        result: response,
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

/**
 * The upload's first step, and once its single point of failure.
 *
 * `crypto.subtle` EXISTS ONLY IN A SECURE CONTEXT. https, `http://localhost`
 * and `http://127.0.0.1` are secure; `http://<hostname>` and `http://<lan-ip>`
 * are not — and those are supported ways to reach a node (`TM8_BIND` plus
 * `TM8_ALLOWED_HOSTNAMES`). On such an origin this threw before a single
 * request left the browser, which is the worst shape a failure can have here:
 * the node never saw it, so it logged nothing, and every surface rendered the
 * generic 'Upload failed. Try again.' over a retry that could never succeed.
 *
 * The checksum cannot simply be skipped — `files.uploadInit` binds
 * `checksumSha256` and the node verifies the staged bytes against it — so the
 * answer is to compute it the other way. WebCrypto stays the path everything
 * actually takes; `sha256HexOfBytes` is only reached where there is none.
 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return sha256HexOfBytes(bytes);
}

/**
 * A client mutation id where `crypto.randomUUID` exists, and one that still
 * works where it does not.
 *
 * `randomUUID` IS SECURE-CONTEXT-GATED, exactly like `crypto.subtle` above. On
 * `http://<hostname>` it is `undefined`, so every upload threw
 * `TypeError: crypto.randomUUID is not a function` on its way to the network —
 * a SECOND secure-context dependency on the same path, and one the checksum
 * fallback alone does not rescue. Measured, not assumed: on a real non-secure
 * origin this page reports `isSecureContext: false`, `crypto.subtle:
 * undefined`, `crypto.randomUUID: undefined`.
 *
 * The fallback shape is `authoring/commands.ts`'s, whose docblock already
 * named this hazard — "a plain-HTTP LAN page would otherwise crash on its
 * first create rather than degrade". It is reused rather than restated, and
 * exported so the file lane has ONE copy instead of the four call sites that
 * each rolled their own bare `crypto.randomUUID()`.
 *
 * A mutation id needs to be unique, not unguessable: the server uses it to
 * reject a replay, never as a capability. Time plus `Math.random` is
 * sufficient for that and is what the existing fallbacks already use.
 */
export function randomMutationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Only used when a caller supplies none. The chat lane passes its own `uuidV7`
 * (time-ordered ids matter to its journal); a panel upload has no journal to
 * order, so a v4 is enough and importing the chat store's module for one
 * function would be a real dependency for a cosmetic gain.
 */
function defaultMutationId(): string {
  return randomMutationId();
}

const SAFE_UPLOAD_ERRORS: Readonly<Record<string, string>> = {
  payload_too_large: 'This file is larger than the allowed upload size.',
  forbidden: 'You do not have permission to upload this file.',
  unauthenticated: 'Sign in again before uploading files.',
  invalid_input: 'This file cannot be uploaded.',
  /* The rest of what this path can actually raise. They were all landing in
     the 'Upload failed. Try again.' bucket, which is why a reporter who hit
     one could not tell anyone WHICH one they hit — the only fact the product
     gave them was that something went wrong. Each entry states the CAUSE and
     stops there; the retry sentence is appended below, once, and only when
     the error says a retry is possible. */
  not_found: 'What this file was being attached to no longer exists.',
  rate_limited: 'Too many uploads at once.',
  version_conflict: 'Something else changed this at the same time.',
  invariant_violation: 'The node took the bytes but could not record the file.',
  upstream_unavailable: 'The node could not be reached.',
  not_implemented: 'This node does not support file uploads.',
};

/**
 * Never surface transport paths, tokens, or arbitrary server prose — the
 * message is chosen from the CODE, and the code alone.
 *
 * 'TRY AGAIN' IS A CLAIM, not punctuation. It is appended only when the error
 * says it is retryable, because telling someone to retry a `forbidden` or a
 * missing capability sends them round a loop the product knows is closed. An
 * error with no `retryable` flag is treated as retryable, matching the wire's
 * own default for an unknown failure.
 */
export function safeUploadReason(error: unknown): string {
  if (error instanceof UploadCancelledError) return 'Upload cancelled.';
  const shape = typeof error === 'object' && error !== null
    ? (error as { code?: unknown; retryable?: unknown })
    : {};
  const code = typeof shape.code === 'string' ? shape.code : null;
  const known = code ? SAFE_UPLOAD_ERRORS[code] : undefined;
  if (known) {
    return shape.retryable === true ? `${known} Try again.` : known;
  }
  return shape.retryable === false ? 'Upload failed.' : 'Upload failed. Try again.';
}

function uploadError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
