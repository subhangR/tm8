import { createHash, randomUUID } from 'node:crypto';

import {
  CollabError,
  SHA256_HEX_RE,
  type FileUploadGrant,
  type SpaceFolderCreateInput,
  type SpaceFolderFileContent,
  type SpaceFolderIngestInput,
  type SpaceFolderListing,
  type SpaceFolderRefusalReason,
  type SpaceFolderSkippedMember,
  type SpaceFolderSummary,
  type SpaceFolderUploadInitInput,
  type SpaceFolderUploadResult,
} from '@tm8/contract';

import type { DbClaims, Querier } from '../../../db/types.js';
import type { W2BlobStore } from '../../../files/w2-blob-store.js';
import {
  SPACE_FOLDER_MAX_EXPANDED_BYTES,
  parseSpaceFolderArchive,
} from '../../../files/space-folder-archive.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { MAX_INLINE_BYTES, mimeForPath } from './project-files.js';

const UPLOAD_TTL_MS = 15 * 60 * 1_000;
const MAX_FOLDER_CHILDREN = 1_000;
const BINARY_SNIFF_BYTES = 8_192;

interface FolderRow {
  id: string;
  space_id: string;
  name: string;
  entry_count: string | number;
  total_size_bytes: string | number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SlotRow {
  id: string;
  space_id: string;
  storage_path: string;
  mime_type: string;
  status: 'pending' | 'completed' | 'aborted' | 'expired';
  size_bytes: string | number;
  checksum_sha256: string;
  staged_size_bytes: string | number | null;
  staged_checksum_sha256: string | null;
  staged_at: Date | string | null;
  expires_at: Date | string;
}

interface InitRpcResult {
  uploadId: string;
  expiresAt: string;
  maxSizeBytes: number;
}

interface RegisterBlobRpcResult {
  blobId: string;
  storagePath: string;
  sizeBytes: string | number;
  inserted: boolean;
}

interface IngestRpcResult {
  folderId: string;
  uploadId: string;
  added: number;
  replaced: number;
  directories: number;
  skipped: SpaceFolderSkippedMember[];
  entryCount: number;
  totalSizeBytes: number;
}

interface StagedBlob {
  path: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  mediaType: string;
}

export interface W2SpaceFoldersServiceOptions {
  readonly blobStore: W2BlobStore;
  readonly now?: () => Date;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function summary(row: FolderRow): SpaceFolderSummary {
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    entryCount: Number(row.entry_count),
    totalSizeBytes: Number(row.total_size_bytes),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function requestClaims(
  deps: FacadeDeps,
  ctx: RequestContext,
): Promise<DbClaims> {
  const owner = await deps.owner();
  return claimsFor(owner, ctx, commandEnvelope(ctx));
}

function validateRelativePath(value: string, allowRoot = true): string {
  if (value === '' && allowRoot) return value;
  if (
    value.length === 0
    || Buffer.byteLength(value, 'utf8') > 1_024
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('//')
    || value.includes('\\')
    // eslint-disable-next-line no-control-regex
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new CollabError('invalid_input', 'path must be normalized and relative to the Space folder');
  }
  return value;
}

function appendPath(prefix: string, path: string): string {
  const combined = prefix === '' ? path : `${prefix}/${path}`;
  return validateRelativePath(combined, false);
}

function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function addDirectoryParents(path: string, directories: Set<string>): void {
  if (path === '') return;
  const segments = path.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    directories.add(segments.slice(0, index).join('/'));
  }
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) if (buffer[index] === 0) return true;
  return false;
}

function refused(
  folderId: string,
  path: string,
  mediaType: string,
  sizeBytes: number,
  reason: SpaceFolderRefusalReason,
  detail: string,
): SpaceFolderFileContent {
  return {
    folderId,
    path,
    mediaType,
    sizeBytes,
    encoding: 'none',
    text: null,
    base64: null,
    refusal: { reason, detail },
    maxInlineBytes: MAX_INLINE_BYTES,
  };
}

async function folderById(q: Querier, folderId: string): Promise<FolderRow> {
  const rows = await q.query<FolderRow>(
    `select id,space_id,name,entry_count,total_size_bytes,created_by,created_at,updated_at
       from public.space_folders where id=$1`,
    [folderId],
  );
  if (!rows[0]) throw new CollabError('not_found', `no such Space folder: ${folderId}`);
  return rows[0];
}

export class W2SpaceFoldersService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2SpaceFoldersServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  readonly list: OperationHandler = async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = await requestClaims(this.deps, ctx);
    const rows = await this.deps.db.query<FolderRow>(
      claims,
      `select id,space_id,name,entry_count,total_size_bytes,created_by,created_at,updated_at
         from public.space_folders where space_id=$1 order by created_at desc,id desc`,
      [spaceId],
    );
    return rows.map(summary);
  };

  readonly create: OperationHandler = async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = ctx.body as SpaceFolderCreateInput;
    const claims = await requestClaims(this.deps, ctx);
    const row = await this.deps.db.rpc<SpaceFolderSummary>(claims, 'create_space_folder', [
      spaceId,
      input.name,
      input.actorId ?? null,
      input.clientMutationId ?? null,
    ]);
    return row;
  };

  readonly uploadInit: OperationHandler = async (ctx) => {
    const folderId = requireUuidParam(ctx, 'folderId');
    const input = ctx.body as SpaceFolderUploadInitInput;
    if (input.sizeBytes > this.options.blobStore.maxSizeBytes) {
      throw new CollabError('payload_too_large', 'folder archive exceeds the configured upload safety limit');
    }
    if (!SHA256_HEX_RE.test(input.checksumSha256)) {
      throw new CollabError('invalid_input', 'archive checksum must be a lowercase SHA-256 digest');
    }
    const claims = await requestClaims(this.deps, ctx);
    const folder = await this.deps.db.tx(claims, (q) => folderById(q, folderId));
    const uploadId = randomUUID();
    const storageBlobId = randomUUID();
    const token = await this.options.blobStore.grantToken(uploadId);
    const expiresAt = new Date(this.now().getTime() + UPLOAD_TTL_MS);
    const name = `${folder.name}.zip`;
    const requestHash = hashJson({
      folderId,
      spaceId: folder.space_id,
      name,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      actorId: input.actorId ?? null,
      maxSizeBytes: this.options.blobStore.maxSizeBytes,
    });
    const result = await this.deps.db.rpc<InitRpcResult>(claims, 'w2_init_file_upload', [
      uploadId,
      folder.space_id,
      input.actorId ?? null,
      name,
      'application/zip',
      input.sizeBytes,
      input.checksumSha256,
      storageBlobId,
      tokenHash(token),
      expiresAt.toISOString(),
      null,
      this.options.blobStore.maxSizeBytes,
      input.clientMutationId,
      requestHash,
    ]);
    const replayToken = await this.options.blobStore.grantToken(result.uploadId);
    return {
      uploadId: result.uploadId,
      uploadUrl: `/v2/files/uploads/${result.uploadId}/content`,
      token: replayToken,
      expiresAt: iso(result.expiresAt),
      maxSizeBytes: Number(result.maxSizeBytes),
    } satisfies FileUploadGrant;
  };

  readonly browse: OperationHandler = async (ctx) => {
    const folderId = requireUuidParam(ctx, 'folderId');
    const path = validateRelativePath(ctx.query.get('path') ?? '');
    const claims = await requestClaims(this.deps, ctx);
    return this.deps.db.tx(claims, async (q) => {
      await folderById(q, folderId);
      const [directories, files] = await Promise.all([
        q.query<{ path: string }>(
          `select path from public.space_folder_dirs
            where folder_id=$1 and parent_path=$2 order by path asc limit $3`,
          [folderId, path, MAX_FOLDER_CHILDREN + 1],
        ),
        q.query<{ path: string; media_type: string; size_bytes: string | number }>(
          `select path,media_type,size_bytes from public.space_folder_entries
            where folder_id=$1 and dir_path=$2 order by path asc limit $3`,
          [folderId, path, MAX_FOLDER_CHILDREN + 1],
        ),
      ]);
      return {
        folderId,
        path,
        directories: directories.slice(0, MAX_FOLDER_CHILDREN).map((row) => ({
          path: row.path,
          name: row.path.slice(row.path.lastIndexOf('/') + 1),
        })),
        files: files.slice(0, MAX_FOLDER_CHILDREN).map((row) => ({
          path: row.path,
          name: row.path.slice(row.path.lastIndexOf('/') + 1),
          mediaType: row.media_type,
          sizeBytes: Number(row.size_bytes),
        })),
        truncated: directories.length > MAX_FOLDER_CHILDREN || files.length > MAX_FOLDER_CHILDREN,
      } satisfies SpaceFolderListing;
    });
  };

  readonly read: OperationHandler = async (ctx) => {
    const folderId = requireUuidParam(ctx, 'folderId');
    const path = validateRelativePath(ctx.query.get('path') ?? '', false);
    const claims = await requestClaims(this.deps, ctx);
    const result = await this.deps.db.tx(claims, async (q) => {
      await folderById(q, folderId);
      const rows = await q.query<{
        media_type: string;
        size_bytes: string | number;
        storage_path: string;
        space_id: string;
      }>(
        `select en.media_type,en.size_bytes,b.storage_path,f.space_id
           from public.space_folder_entries en
           join public.space_folders f on f.id=en.folder_id
           join public.stored_blobs b on b.id=en.blob_id
          where en.folder_id=$1 and en.path=$2`,
        [folderId, path],
      );
      return rows[0] ?? null;
    });
    if (!result) {
      return refused(folderId, path, 'application/octet-stream', 0, 'not-found', 'no such file in this Space folder');
    }
    const sizeBytes = Number(result.size_bytes);
    if (sizeBytes > MAX_INLINE_BYTES) {
      return refused(
        folderId,
        path,
        result.media_type,
        sizeBytes,
        'too-large',
        `file is ${sizeBytes} bytes; the inline ceiling is ${MAX_INLINE_BYTES}`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await this.options.blobStore.read(result.storage_path, result.space_id);
    } catch {
      return refused(folderId, path, result.media_type, sizeBytes, 'unreadable', 'stored bytes are unavailable');
    }
    if (looksBinary(bytes)) {
      if (/^(image|audio|video)\//.test(result.media_type) && result.media_type !== 'image/svg+xml') {
        return {
          folderId,
          path,
          mediaType: result.media_type,
          sizeBytes,
          encoding: 'base64',
          text: null,
          base64: bytes.toString('base64'),
          refusal: null,
          maxInlineBytes: MAX_INLINE_BYTES,
        } satisfies SpaceFolderFileContent;
      }
      return refused(
        folderId,
        path,
        result.media_type,
        sizeBytes,
        'binary-not-previewable',
        'this file is binary and has no inline preview',
      );
    }
    return {
      folderId,
      path,
      mediaType: result.media_type,
      sizeBytes,
      encoding: 'utf8',
      text: bytes.toString('utf8'),
      base64: null,
      refusal: null,
      maxInlineBytes: MAX_INLINE_BYTES,
    } satisfies SpaceFolderFileContent;
  };

  readonly ingest: OperationHandler = async (ctx) => {
    const folderId = requireUuidParam(ctx, 'folderId');
    const input = ctx.body as SpaceFolderIngestInput;
    const destPath = validateRelativePath(input.destPath ?? '');
    const claims = await requestClaims(this.deps, ctx);

    const replay = await this.deps.db.rpc<IngestRpcResult | null>(claims, 'lookup_space_folder_ingest', [
      folderId,
      input.uploadId,
      input.clientMutationId,
    ]);
    if (replay) return this.uploadResult(claims, folderId, replay);

    const { folder, slot } = await this.deps.db.tx(claims, async (q) => {
      const selectedFolder = await folderById(q, folderId);
      const slots = await q.query<SlotRow>(
        `select id,space_id,storage_path,mime_type,status,size_bytes,checksum_sha256,
                staged_size_bytes,staged_checksum_sha256,staged_at,expires_at
           from public.file_upload_slots where id=$1`,
        [input.uploadId],
      );
      if (!slots[0]) throw new CollabError('not_found', `no such upload: ${input.uploadId}`);
      return { folder: selectedFolder, slot: slots[0] };
    });
    if (slot.space_id !== folder.space_id || slot.mime_type !== 'application/zip') {
      throw new CollabError('invalid_input', 'upload is not an archive for this Space folder');
    }
    if (slot.status !== 'pending' || new Date(slot.expires_at).getTime() <= this.now().getTime()) {
      throw new CollabError('invalid_input', 'folder archive upload is no longer pending');
    }
    if (slot.staged_at === null || slot.staged_size_bytes === null || slot.staged_checksum_sha256 === null) {
      throw new CollabError('invalid_input', 'folder archive bytes are incomplete');
    }
    await this.options.blobStore.verify(
      slot.storage_path,
      slot.space_id,
      Number(slot.size_bytes),
      slot.checksum_sha256,
    );

    const archive = await this.options.blobStore.read(slot.storage_path, slot.space_id);
    let parsed: ReturnType<typeof parseSpaceFolderArchive>;
    try {
      parsed = parseSpaceFolderArchive(archive, {
        maxExpandedBytes: Math.min(SPACE_FOLDER_MAX_EXPANDED_BYTES, this.options.blobStore.maxSizeBytes),
      });
    } catch (error) {
      await this.cleanupArchive(claims, slot, input.clientMutationId);
      throw new CollabError('invalid_input', `folder archive is invalid: ${String(error)}`);
    }

    const directories = new Set<string>();
    if (destPath !== '') addDirectoryParents(destPath, directories);
    const skipped: SpaceFolderSkippedMember[] = [...parsed.skipped];
    for (const path of parsed.directories) {
      try {
        addDirectoryParents(appendPath(destPath, path), directories);
      } catch {
        skipped.push({ path, reason: 'path-too-long', detail: 'destination prefix makes the path too long' });
      }
    }

    const files: Array<{ path: string; bytes: Buffer }> = [];
    for (const file of parsed.files) {
      try {
        files.push({ path: appendPath(destPath, file.path), bytes: file.bytes });
      } catch {
        skipped.push({ path: file.path, reason: 'path-too-long', detail: 'destination prefix makes the path too long' });
      }
    }

    const staged: StagedBlob[] = [];
    let committed = false;
    try {
      for (const file of files) {
        const sha256 = createHash('sha256').update(file.bytes).digest('hex');
        const storagePath = this.options.blobStore.storagePath(folder.space_id, randomUUID());
        await this.options.blobStore.writeUpload({
          stream: (async function* () { if (file.bytes.length > 0) yield file.bytes; })(),
          storagePath,
          expectedSpaceId: folder.space_id,
          expectedSizeBytes: file.bytes.length,
          expectedChecksumSha256: sha256,
          allowEmpty: true,
        });
        staged.push({
          path: file.path,
          sha256,
          sizeBytes: file.bytes.length,
          storagePath,
          mediaType: mimeForPath(file.path),
        });
        addDirectoryParents(parentPath(file.path), directories);
      }

      const { rpc, redundant } = await this.deps.db.tx(claims, async (q) => {
        const redundantPaths: string[] = [];
        for (const blob of staged) {
          const registered = await q.rpc<RegisterBlobRpcResult>('register_stored_blob', [
            folder.space_id,
            blob.sha256,
            blob.sizeBytes,
            blob.storagePath,
            input.actorId ?? null,
          ]);
          if (!registered.inserted && registered.storagePath !== blob.storagePath) {
            redundantPaths.push(blob.storagePath);
          }
        }
        const entries = staged.map((blob) => ({
          path: blob.path,
          dirPath: parentPath(blob.path),
          mediaType: blob.mediaType,
          sizeBytes: blob.sizeBytes,
          sha256: blob.sha256,
        }));
        const ingest = await q.rpc<IngestRpcResult>('ingest_space_folder', [
          folderId,
          input.uploadId,
          JSON.stringify([...directories].filter(Boolean)),
          JSON.stringify(entries),
          JSON.stringify(skipped),
          input.actorId ?? null,
          input.clientMutationId,
        ]);
        return { rpc: ingest, redundant: redundantPaths };
      });
      committed = true;
      // The database transaction is committed at this point. A best-effort
      // cleanup failure for a duplicate staging file must never fall through to
      // the rollback catch below, which would delete newly canonical bytes that
      // live entries now reference.
      await Promise.all(redundant.map((path) =>
        this.options.blobStore.remove(path, folder.space_id).catch(() => undefined)));
      await this.cleanupArchive(claims, slot, input.clientMutationId);
      return this.uploadResult(claims, folderId, rpc);
    } catch (error) {
      if (!committed) {
        await Promise.all(staged.map((blob) =>
          this.options.blobStore.remove(blob.storagePath, folder.space_id).catch(() => undefined)));
      }
      await this.cleanupArchive(claims, slot, input.clientMutationId);
      throw error;
    }
  };

  private async cleanupArchive(claims: DbClaims, slot: SlotRow, mutationId: string): Promise<void> {
    await this.deps.db.rpc(claims, 'w2_abort_file_upload', [slot.id, `${mutationId}/archive-cleanup`])
      .catch(() => undefined);
    await this.options.blobStore.remove(slot.storage_path, slot.space_id).catch(() => undefined);
  }

  private async uploadResult(
    claims: DbClaims,
    folderId: string,
    rpc: IngestRpcResult,
  ): Promise<SpaceFolderUploadResult> {
    const folder = await this.deps.db.tx(claims, (q) => folderById(q, folderId));
    return {
      folder: summary(folder),
      added: Number(rpc.added),
      replaced: Number(rpc.replaced),
      directories: Number(rpc.directories),
      skipped: rpc.skipped,
    };
  }
}
