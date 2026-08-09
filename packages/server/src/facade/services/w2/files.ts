import { createHash, randomUUID } from 'node:crypto';

import {
  CollabError,
  FILE_MAX_SIZE_BYTES_DEFAULT,
  type CommandResult,
  type FileUploadCompleteInput,
  type FileUploadGrant,
  type FileUploadInitInput,
} from '@tm8/contract';

import type { DbClaims } from '../../../db/types.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import { raw, rawStream } from '../../../http/types.js';
import type { W2BlobStore } from '../../../files/w2-blob-store.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { toCommandResult, type RpcCommandResult } from '../../handlers/entities.js';

const UPLOAD_TTL_MS = 15 * 60 * 1_000;
const MAX_NAME_CHARS = 500;
const MAX_MIME_CHARS = 255;

interface InitRpcResult {
  uploadId: string;
  storagePath: string;
  expiresAt: string;
  maxSizeBytes: number;
  requestHash?: string;
}

interface SlotRow {
  id: string;
  space_id: string;
  storage_path: string;
  status: 'pending' | 'completed' | 'aborted' | 'expired';
  size_bytes: string | number;
  checksum_sha256: string;
  staged_size_bytes: string | number | null;
  staged_checksum_sha256: string | null;
  staged_at: Date | string | null;
  expires_at: Date | string;
}

interface CompleteRpcResult extends RpcCommandResult {
  outcome: 'completed' | 'aborted' | 'expired' | 'pending';
  uploadId: string;
  storagePath: string;
  spaceId: string;
}

interface AbortRpcResult {
  outcome: 'completed' | 'aborted' | 'expired';
  uploadId: string;
  storagePath: string;
  spaceId: string;
}

interface DownloadRow {
  entity_id: string;
  space_id: string;
  name: string;
  mime_type: string;
  size_bytes: string | number;
  checksum_sha256: string | null;
  storage_path: string;
}

export interface W2FilesServiceOptions {
  readonly blobStore: W2BlobStore;
  /** Effective deployment ceiling; integration supplies an override to both this service and the blob store. */
  readonly maxSizeBytes?: number;
  readonly now?: () => Date;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function requireAuthenticatedIdentity(ctx: RequestContext, ownerIdentityId: string): string {
  if (ctx.identity.kind === 'anonymous') {
    throw new CollabError('unauthenticated', 'authentication is required');
  }
  if (ctx.identity.kind === 'auto-owner') return ownerIdentityId;
  if (!ctx.identity.identityId) {
    throw new CollabError('unauthenticated', 'bearer identity is unresolved');
  }
  return ctx.identity.identityId;
}

async function requestClaims(
  deps: FacadeDeps,
  ctx: RequestContext,
  envelope: ReturnType<typeof commandEnvelope> = {},
): Promise<{ claims: DbClaims; viewerIdentityId: string }> {
  const owner = await deps.owner();
  const viewerIdentityId = requireAuthenticatedIdentity(ctx, owner.identityId);
  const base = claimsFor(owner, ctx, envelope);
  return {
    viewerIdentityId,
    claims: {
      ...base,
      identityId: viewerIdentityId,
      nodeAdmin: viewerIdentityId === owner.identityId ? owner.isNodeAdmin : false,
    },
  };
}

function validateMetadata(input: FileUploadInitInput, maxSizeBytes: number): void {
  if (input.name.trim().length === 0 || input.name.length > MAX_NAME_CHARS) {
    throw new CollabError('invalid_input', 'file name must contain 1..500 characters');
  }
  if (input.mime.length > MAX_MIME_CHARS || /[\u0000-\u001f\u007f]/.test(input.mime)) {
    throw new CollabError('invalid_input', 'file MIME type is invalid');
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new CollabError('invalid_input', 'file size must be a positive integer');
  }
  if (input.sizeBytes > maxSizeBytes) {
    throw new CollabError('payload_too_large', 'file exceeds the configured size limit');
  }
}

function storageDisposition(name: string, mime: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_NAME_CHARS) || 'download';
  const ascii = clean
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\/]/g, '_')
    .slice(0, 120) || 'download';
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (value) =>
    `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const media = (/^(?:image|audio|video)\//i.test(mime) && !/^image\/svg\+xml$/i.test(mime));
  return `${media ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function safeMime(mime: string): string {
  return mime.length <= MAX_MIME_CHARS && !/[\u0000-\u001f\u007f]/.test(mime)
    ? mime
    : 'application/octet-stream';
}

function headerValue(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Strong-compare `If-None-Match` against the blob's checksum ETag. Weak tags
 * (`W/"…"`) never match a byte-exact download, per RFC 9110 §8.8.3.2.
 */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const candidates = header.split(',').map((part) => part.trim());
  return candidates.includes('*') || candidates.includes(etag);
}

const SINGLE_BYTE_RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolve a `Range` header to an inclusive byte span.
 *
 * Returns `null` for "serve the whole file": no header, a shape we do not
 * support (multi-range, non-bytes units — RFC 9110 lets a server ignore
 * those), or an `If-Range` validator that no longer matches. Returns
 * `'unsatisfiable'` only for a well-formed bytes range that names no
 * satisfiable byte, which MUST be a 416.
 */
function parseByteRange(
  rangeHeader: string | undefined,
  ifRangeHeader: string | undefined,
  etag: string,
  sizeBytes: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (rangeHeader === undefined) return null;
  const match = SINGLE_BYTE_RANGE_RE.exec(rangeHeader.trim());
  if (!match) return null;
  // An If-Range mismatch means the client's partial copy is of different
  // bytes; serving the range would splice two versions together.
  if (ifRangeHeader !== undefined && ifRangeHeader.trim() !== etag) return null;

  const [, firstRaw, lastRaw] = match;
  if (firstRaw === '' && lastRaw === '') return null;
  if (firstRaw === '') {
    // suffix form: last N bytes
    const suffix = Number(lastRaw);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || sizeBytes === 0) return 'unsatisfiable';
    const span = Math.min(suffix, sizeBytes);
    return { start: sizeBytes - span, end: sizeBytes - 1 };
  }
  const start = Number(firstRaw);
  if (!Number.isSafeInteger(start) || start >= sizeBytes) return 'unsatisfiable';
  if (lastRaw === '') return { start, end: sizeBytes - 1 };
  const end = Number(lastRaw);
  // last-byte-pos < first-byte-pos makes the whole header INVALID (not merely
  // unsatisfiable), which RFC 9110 says to ignore.
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, sizeBytes - 1) };
}

export class W2FilesService {
  private readonly now: () => Date;
  private readonly maxSizeBytes: number;

  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2FilesServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxSizeBytes = options.maxSizeBytes ?? FILE_MAX_SIZE_BYTES_DEFAULT;
    if (!Number.isSafeInteger(this.maxSizeBytes) || this.maxSizeBytes <= 0) {
      throw new Error('effective file max size must be a positive safe integer');
    }
    if (this.maxSizeBytes > options.blobStore.maxSizeBytes) {
      throw new Error('effective file max size exceeds the injected blob store limit');
    }
  }

  readonly uploadInit: OperationHandler = async (ctx) => {
    const input = ctx.body as FileUploadInitInput;
    validateMetadata(input, this.maxSizeBytes);
    const { claims } = await requestClaims(this.deps, ctx, commandEnvelope(ctx));
    const uploadId = randomUUID();
    const storageBlobId = randomUUID();
    const token = await this.options.blobStore.grantToken(uploadId);
    const expiresAt = new Date(this.now().getTime() + UPLOAD_TTL_MS);
    const requestHash = hashJson({
      spaceId: input.spaceId,
      actorId: input.actorId ?? null,
      name: input.name,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      entityId: input.entityId ?? null,
      maxSizeBytes: this.maxSizeBytes,
    });
    const result = await this.deps.db.rpc<InitRpcResult>(claims, 'w2_init_file_upload', [
      uploadId,
      input.spaceId,
      input.actorId ?? null,
      input.name,
      input.mime,
      input.sizeBytes,
      input.checksumSha256,
      storageBlobId,
      tokenHash(token),
      expiresAt.toISOString(),
      input.entityId ?? null,
      this.maxSizeBytes,
      input.clientMutationId ?? null,
      requestHash,
    ]);

    // On a ledger replay the database returns the original upload id. The
    // token is deterministic from that id and the dataDir-private grant key,
    // so the replay is byte-for-byte the same grant without storing plaintext
    // credentials in Postgres.
    const replayToken = await this.options.blobStore.grantToken(result.uploadId);
    const grant: FileUploadGrant = {
      uploadId: result.uploadId,
      uploadUrl: `/v2/files/uploads/${result.uploadId}/content`,
      token: replayToken,
      expiresAt: new Date(result.expiresAt).toISOString(),
      maxSizeBytes: Number(result.maxSizeBytes),
    };
    return grant;
  };

  readonly uploadComplete: OperationHandler = async (ctx) => {
    const uploadId = requireUuidParam(ctx, 'uploadId');
    const input = ctx.body as FileUploadCompleteInput;
    const { claims, viewerIdentityId } = await requestClaims(this.deps, ctx, commandEnvelope(ctx));
    const slotRows = await this.deps.db.query<SlotRow>(
      claims,
      `select id,space_id,storage_path,status,size_bytes,checksum_sha256,
              staged_size_bytes,staged_checksum_sha256,staged_at,expires_at
         from public.file_upload_slots where id=$1`,
      [uploadId],
    );
    const slot = slotRows[0];
    if (!slot) throw new CollabError('not_found', `no such upload: ${uploadId}`);

    let actualSize: number | null = null;
    let actualChecksum: string | null = null;
    if (slot.status === 'pending' && new Date(slot.expires_at).getTime() > this.now().getTime()) {
      if (slot.staged_at === null || slot.staged_size_bytes === null || slot.staged_checksum_sha256 === null) {
        throw new CollabError('invalid_input', 'upload bytes are incomplete');
      }
      const verified = await this.options.blobStore.verify(
        slot.storage_path,
        slot.space_id,
        Number(slot.size_bytes),
        slot.checksum_sha256,
      );
      actualSize = verified.sizeBytes;
      actualChecksum = verified.checksumSha256;
    }

    const settled = await this.deps.db.tx(claims, async (q) => {
      const result = await q.rpc<CompleteRpcResult>('w2_complete_file_upload', [
        uploadId,
        actualSize,
        actualChecksum,
        input.clientMutationId,
        input.targets ?? [],
      ]);
      if (result.outcome !== 'completed') return { result };
      return { result, command: await toCommandResult(q, result, viewerIdentityId) };
    });

    if (settled.result.outcome === 'completed' && settled.command) return settled.command;
    if (settled.result.outcome === 'expired') {
      await this.options.blobStore.remove(settled.result.storagePath, settled.result.spaceId);
      throw new CollabError('invalid_input', 'upload slot has expired');
    }
    if (settled.result.outcome === 'aborted') {
      await this.options.blobStore.remove(settled.result.storagePath, settled.result.spaceId);
      throw new CollabError('invalid_input', 'upload slot was aborted');
    }
    throw new CollabError('invalid_input', 'upload bytes are incomplete');
  };

  readonly uploadAbort: OperationHandler = async (ctx) => {
    const uploadId = requireUuidParam(ctx, 'uploadId');
    const { claims } = await requestClaims(this.deps, ctx, commandEnvelope(ctx));
    const result = await this.deps.db.rpc<AbortRpcResult>(claims, 'w2_abort_file_upload', [
      uploadId,
      commandEnvelope(ctx).clientMutationId ?? null,
    ]);
    if (result.outcome !== 'completed') {
      await this.options.blobStore.remove(result.storagePath, result.spaceId);
    }
    return { patches: [] } satisfies CommandResult;
  };

  readonly download: OperationHandler = async (ctx) => {
    const fileEntityId = requireUuidParam(ctx, 'fileEntityId');
    const { claims } = await requestClaims(this.deps, ctx);
    const rows = await this.deps.db.query<DownloadRow>(
      claims,
      `select e.id entity_id,e.space_id,f.name,f.mime_type,f.size_bytes,
              f.checksum_sha256,f.storage_path
         from public.entities e
         join public.files f on f.entity_id=e.id
        where e.id=$1 and e.kind='file' and e.deleted_at is null`,
      [fileEntityId],
    );
    const file = rows[0];
    if (!file || !file.checksum_sha256) {
      throw new CollabError('not_found', `no readable file: ${fileEntityId}`);
    }
    const mime = safeMime(file.mime_type);
    const checksum = file.checksum_sha256;
    const etag = `"sha256-${checksum}"`;
    const declaredSize = Number(file.size_bytes);
    const baseHeaders = {
      'content-type': mime,
      'content-disposition': storageDisposition(file.name, mime),
      'x-content-type-options': 'nosniff',
      'x-tm8-checksum-sha256': checksum,
      etag,
      digest: `sha-256=${Buffer.from(checksum, 'hex').toString('base64')}`,
      'accept-ranges': 'bytes',
      // The blob is content-addressed by its checksum ETag, so revalidation is
      // free and the bytes themselves never change under one entity id.
      'cache-control': 'private, no-cache',
    };

    if (etagMatches(headerValue(ctx, 'if-none-match'), etag)) {
      return raw(304, baseHeaders, '');
    }

    // The upload path verified size+checksum before the slot completed; here a
    // cheap stat guards metadata/bytes divergence without re-reading the whole
    // blob on every download (which forced full buffering and made large
    // files unstreamable).
    const range = parseByteRange(headerValue(ctx, 'range'), headerValue(ctx, 'if-range'), etag, declaredSize);
    if (range === 'unsatisfiable') {
      return raw(416, {
        ...baseHeaders,
        'content-range': `bytes */${declaredSize}`,
      }, '');
    }

    const opened = await this.options.blobStore.openRead(
      file.storage_path,
      file.space_id,
      range ?? undefined,
    );
    if (opened.sizeBytes !== declaredSize) {
      opened.stream.destroy();
      throw new CollabError('upstream_unavailable', 'stored blob metadata does not match its bytes');
    }
    if (range === null) {
      return rawStream(200, {
        ...baseHeaders,
        'content-length': String(declaredSize),
      }, opened.stream);
    }
    return rawStream(206, {
      ...baseHeaders,
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${declaredSize}`,
    }, opened.stream);
  };
}

export type { InitRpcResult, SlotRow, CompleteRpcResult, AbortRpcResult };
