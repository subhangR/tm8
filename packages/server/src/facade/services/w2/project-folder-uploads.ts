import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CollabError,
  FILE_MAX_SIZE_BYTES_DEFAULT,
  PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES,
  PROJECT_FOLDER_UPLOAD_MAX_FILES,
  PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES,
  PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES,
  type CommandResult,
  type ProjectFolderUploadGrant,
  type ProjectFolderUploadInitInput,
  type ProjectFolderUploadResult,
  type ProjectResource,
} from '@tm8/contract';

import type { DbClaims } from '../../../db/types.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { W2BlobStore } from '../../../files/w2-blob-store.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { canonicalDirectory, canonicalRoots, requireAllowed } from './project-directories.js';
import { isSecretBasename } from './project-file-policy.js';
import {
  materializeProjectFolder,
  normalizeProjectFolderManifest,
  type NormalizedProjectFolderManifest,
} from './project-folder-upload.js';
import { toProjectResource } from './projects-associations.js';

const UPLOAD_TTL_MS = 15 * 60 * 1_000;

/** The sha-256 of zero bytes; zero-byte files carry no grant and no slot. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface FolderUploadStateFile {
  relativePath: string;
  sizeBytes: number;
  checksumSha256: string;
  /** Null for a zero-byte file: nothing to transport, nothing staged. */
  uploadId: string | null;
  storagePath: string | null;
}

/** Frozen at init; the JSON file under `stateDir` IS the upload session. */
interface FolderUploadState {
  folderUploadId: string;
  spaceId: string;
  /** The identity that opened the upload; complete/abort require the same one. */
  identityId: string;
  actorId: string | null;
  projectName: string;
  destinationParent: string;
  rootName: string;
  trust: string;
  mode: 'create' | 'merge';
  manifest: NormalizedProjectFolderManifest;
  files: FolderUploadStateFile[];
  expiresAt: string;
  createdAt: string;
}

interface SlotStagingRow {
  id: string;
  status: string;
  staged_at: Date | string | null;
  staged_size_bytes: string | number | null;
  staged_checksum_sha256: string | null;
}

export interface W2ProjectFolderUploadServiceOptions {
  readonly blobStore: W2BlobStore;
  readonly stateDir: string;
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

/**
 * projects.folderUploads.* — the browser-originated folder import lifecycle.
 *
 * init freezes a validated relative-path manifest, opens one ordinary
 * file-upload slot per non-empty file (the EXISTING raw PUT transport stages
 * and verifies the bytes), and records the session as a JSON file under
 * `stateDir`. complete re-verifies every staged blob, materializes the tree
 * beneath a server-authorized destination (`project-folder-upload.ts`),
 * creates-or-reuses the Project, links it to the Space (R7), and only then
 * releases the staging. abort releases everything. Staged blobs never outlive
 * the session: every terminal path removes them.
 */
export class W2ProjectFolderUploadService {
  private readonly now: () => Date;
  private readonly maxSizeBytes: number;

  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2ProjectFolderUploadServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxSizeBytes = options.maxSizeBytes ?? FILE_MAX_SIZE_BYTES_DEFAULT;
    if (!Number.isSafeInteger(this.maxSizeBytes) || this.maxSizeBytes <= 0) {
      throw new Error('effective file max size must be a positive safe integer');
    }
  }

  readonly init: OperationHandler = async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = ctx.body as ProjectFolderUploadInitInput;
    const { claims, viewerIdentityId } = await this.requestClaims(ctx);

    // C2 (Lane 3): PURE validation first — nothing below may touch the
    // filesystem until every name in the request has been refused or cleared,
    // so a hostile rootName/path never turns a stat into an existence oracle.
    validateRootNameStrict(input.rootName);
    let manifest: NormalizedProjectFolderManifest;
    try {
      manifest = normalizeProjectFolderManifest(input.entries);
    } catch (error) {
      throw new CollabError('invalid_input', (error as Error).message);
    }
    for (const file of manifest.files) {
      refuseProtectedComponents(file.relativePath);
      if (file.sizeBytes > this.maxSizeBytes) {
        throw new CollabError('payload_too_large', `${file.relativePath} exceeds the configured size limit`);
      }
      if (file.sizeBytes === 0 && file.checksumSha256 !== EMPTY_SHA256) {
        throw new CollabError('invalid_input', `${file.relativePath} declares zero bytes with a non-empty checksum`);
      }
    }
    for (const directory of manifest.directories) {
      refuseProtectedComponents(directory);
    }

    // C1 (Lane 3): importing bytes onto the node's disk at an arbitrary
    // in-roots destination is node-admin only, matching the createProject
    // ensureWorkingDir precedent. Provisional policy until an owner approves
    // a server-managed import root for ordinary members.
    requireNodeAdmin(claims);

    // Containment BEFORE the first probe of the target: a lexically
    // out-of-jail parent is forbidden without any filesystem access, so the
    // refusal cannot disclose what exists there.
    const roots = await canonicalRoots();
    requireAllowed(resolve(input.destinationParent), roots);
    const destinationParent = await canonicalDirectory(input.destinationParent);
    requireAllowed(destinationParent, roots);
    const workingDir = resolve(destinationParent, input.rootName);
    const mode = input.mode ?? 'create';
    const destinationExists = await stat(workingDir).then((s) => s.isDirectory()).catch(() => false);
    if (mode === 'create' && destinationExists) {
      throw new CollabError('conflict', `destination ${input.rootName} already exists; use mode 'merge' to re-upload`);
    }
    if (mode === 'merge' && !destinationExists) {
      throw new CollabError('invalid_input', `merge destination ${input.rootName} does not exist`);
    }

    const folderUploadId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + UPLOAD_TTL_MS);
    const grants: ProjectFolderUploadGrant['files'] = [];
    const files: FolderUploadStateFile[] = [];
    const openedSlots: string[] = [];

    try {
      for (const file of manifest.files) {
        if (file.sizeBytes === 0) {
          files.push({ ...pick(file), uploadId: null, storagePath: null });
          continue;
        }
        const uploadId = randomUUID();
        const storageBlobId = randomUUID();
        const name = file.relativePath.split('/').at(-1)!;
        const token = await this.options.blobStore.grantToken(uploadId);
        const requestHash = hashJson({
          folderUploadId, spaceId, relativePath: file.relativePath,
          sizeBytes: file.sizeBytes, checksumSha256: file.checksumSha256,
        });
        const slot = await this.deps.db.rpc<{ uploadId: string; storagePath: string }>(
          claims, 'w2_init_file_upload', [
            uploadId, spaceId, input.actorId ?? null, name, file.mime,
            file.sizeBytes, file.checksumSha256, storageBlobId,
            tokenHash(token), expiresAt.toISOString(), null,
            this.maxSizeBytes, null, requestHash,
          ],
        );
        openedSlots.push(slot.uploadId);
        files.push({ ...pick(file), uploadId: slot.uploadId, storagePath: slot.storagePath });
        grants.push({
          uploadId: slot.uploadId,
          uploadUrl: `/v2/files/uploads/${slot.uploadId}/content`,
          token,
          expiresAt: expiresAt.toISOString(),
          maxSizeBytes: this.maxSizeBytes,
          relativePath: file.relativePath,
        });
      }

      const state: FolderUploadState = {
        folderUploadId,
        spaceId,
        identityId: viewerIdentityId,
        actorId: input.actorId ?? null,
        projectName: input.projectName,
        destinationParent,
        rootName: input.rootName,
        trust: input.trust ?? 'untrusted',
        mode,
        manifest,
        files,
        expiresAt: expiresAt.toISOString(),
        createdAt: this.now().toISOString(),
      };
      await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
      await writeFile(this.statePath(folderUploadId), JSON.stringify(state), {
        flag: 'wx', mode: 0o600,
      });
    } catch (error) {
      await this.releaseSlots(claims, spaceId, files).catch(() => undefined);
      throw error;
    }

    const grant: ProjectFolderUploadGrant = {
      folderUploadId,
      expiresAt: expiresAt.toISOString(),
      maxFiles: PROJECT_FOLDER_UPLOAD_MAX_FILES,
      maxDirectories: PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES,
      maxTotalBytes: PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES,
      maxPathBytes: PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES,
      files: grants,
    };
    return grant;
  };

  readonly complete: OperationHandler = async (ctx) => {
    const folderUploadId = requireUuidParam(ctx, 'folderUploadId');
    const { claims, viewerIdentityId } = await this.requestClaims(ctx);
    // C1: gate BEFORE the session is even looked up — a non-admin cannot
    // probe which folderUploadIds exist.
    requireNodeAdmin(claims);
    const state = await this.loadState(folderUploadId, viewerIdentityId);

    if (new Date(state.expiresAt).getTime() <= this.now().getTime()) {
      await this.release(claims, state);
      throw new CollabError('invalid_input', 'folder upload has expired');
    }

    // Every transported file must be fully staged with the declared bytes.
    const slotIds = state.files.filter((f) => f.uploadId !== null).map((f) => f.uploadId!);
    if (slotIds.length > 0) {
      const rows = await this.deps.db.query<SlotStagingRow>(
        claims,
        `select id,status,staged_at,staged_size_bytes,staged_checksum_sha256
           from public.file_upload_slots where id = any($1::uuid[])`,
        [slotIds],
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const file of state.files) {
        if (file.uploadId === null) continue;
        const row = byId.get(file.uploadId);
        if (!row || row.status !== 'pending' || row.staged_at === null
            || Number(row.staged_size_bytes) !== file.sizeBytes
            || row.staged_checksum_sha256 !== file.checksumSha256) {
          throw new CollabError('invalid_input', `upload bytes are incomplete for ${file.relativePath}`);
        }
      }
    }

    const byPath = new Map(state.files.map((file) => [file.relativePath, file]));
    let materialized;
    try {
      materialized = await materializeProjectFolder({
        folderUploadId: state.folderUploadId,
        destinationParent: state.destinationParent,
        rootName: state.rootName,
        manifest: state.manifest,
        allowedRoots: await canonicalRoots(),
        mode: state.mode,
        readBytes: async (relativePath) => {
          const file = byPath.get(relativePath);
          if (!file) throw new Error(`no staged entry for ${relativePath}`);
          if (file.storagePath === null) return new Uint8Array(0);
          return this.options.blobStore.read(file.storagePath, state.spaceId);
        },
      });
    } catch (error) {
      // The materializer already removed anything it created; staging and the
      // session survive so a transient failure can be retried or aborted.
      throw new CollabError('invalid_input', (error as Error).message);
    }

    const project = await this.resolveProject(ctx, claims, state, materialized.workingDir);

    await this.deps.db.rpc(claims, 'link_project_w2', [
      state.spaceId, project.id, state.actorId, null,
    ]);

    await this.release(claims, state);

    const result: ProjectFolderUploadResult = {
      folderUploadId: state.folderUploadId,
      spaceId: state.spaceId,
      project,
      rootName: state.rootName,
      fileCount: materialized.fileCount,
      directoryCount: materialized.directoryCount,
      totalBytes: materialized.totalBytes,
      replacedCount: materialized.replacedCount,
    };
    return result;
  };

  readonly abort: OperationHandler = async (ctx) => {
    const folderUploadId = requireUuidParam(ctx, 'folderUploadId');
    const { claims, viewerIdentityId } = await this.requestClaims(ctx);
    requireNodeAdmin(claims);
    const state = await this.loadState(folderUploadId, viewerIdentityId);
    await this.release(claims, state);
    return { patches: [] } satisfies CommandResult;
  };

  private async requestClaims(
    ctx: RequestContext,
  ): Promise<{ claims: DbClaims; viewerIdentityId: string }> {
    const owner = await this.deps.owner();
    const viewerIdentityId = requireAuthenticatedIdentity(ctx, owner.identityId);
    const base = claimsFor(owner, ctx, commandEnvelope(ctx));
    return {
      viewerIdentityId,
      claims: {
        ...base,
        identityId: viewerIdentityId,
        nodeAdmin: viewerIdentityId === owner.identityId ? owner.isNodeAdmin : false,
      },
    };
  }

  private statePath(folderUploadId: string): string {
    return resolve(this.options.stateDir, `${folderUploadId}.json`);
  }

  private async loadState(folderUploadId: string, viewerIdentityId: string): Promise<FolderUploadState> {
    let raw: string;
    try {
      raw = await readFile(this.statePath(folderUploadId), 'utf8');
    } catch {
      throw new CollabError('not_found', `no such folder upload: ${folderUploadId}`);
    }
    const state = JSON.parse(raw) as FolderUploadState;
    if (state.identityId !== viewerIdentityId) {
      throw new CollabError('forbidden', 'folder upload belongs to another identity');
    }
    return state;
  }

  /** Merge reuses the project already anchored at workingDir; create refuses to. */
  private async resolveProject(
    ctx: RequestContext,
    claims: DbClaims,
    state: FolderUploadState,
    workingDir: string,
  ): Promise<ProjectResource> {
    type ProjectRow = Parameters<typeof toProjectResource>[0];
    if (state.mode === 'merge') {
      const rows = await this.deps.db.query<ProjectRow>(
        claims,
        `select * from public.projects where working_dir = $1 limit 1`,
        [workingDir],
      );
      if (rows[0]) return toProjectResource(rows[0]);
    }
    const raw = await this.deps.db.rpc<{ project: ProjectRow }>(claims, 'create_project', [
      state.projectName,
      workingDir,
      null,
      state.trust,
      JSON.stringify({}),
      commandEnvelope(ctx).clientMutationId ?? null,
    ]);
    return toProjectResource(raw.project);
  }

  /** Terminal cleanup: abort still-pending slots, drop staged blobs and state. */
  private async release(claims: DbClaims, state: FolderUploadState): Promise<void> {
    await this.releaseSlots(claims, state.spaceId, state.files);
    await unlink(this.statePath(state.folderUploadId)).catch(() => undefined);
  }

  private async releaseSlots(
    claims: DbClaims,
    spaceId: string,
    files: FolderUploadStateFile[],
  ): Promise<void> {
    for (const file of files) {
      if (file.uploadId === null) continue;
      await this.deps.db.rpc(claims, 'w2_abort_file_upload', [file.uploadId, null])
        .catch(() => undefined);
      if (file.storagePath !== null) {
        await this.options.blobStore.remove(file.storagePath, spaceId).catch(() => undefined);
      }
    }
  }
}

function requireNodeAdmin(claims: DbClaims): void {
  if (claims.nodeAdmin !== true) {
    throw new CollabError('forbidden', "node-admin access is required to import a folder onto the node's disk");
  }
}

/** rootName is ONE directory name: no separators, no dot-dirs, no secrets. */
function validateRootNameStrict(rootName: string): void {
  if (
    rootName.length === 0
    || rootName === '.'
    || rootName === '..'
    || /[\\/\u0000-\u001f\u007f]/.test(rootName)
  ) {
    throw new CollabError('invalid_input', 'rootName must be one directory name');
  }
  if (isSecretBasename(rootName) || rootName === '.git') {
    throw new CollabError('invalid_input', 'rootName names a protected file');
  }
}

/**
 * C2/C3: a browser import never writes credential material or repo internals.
 * `.git` as ANY component is refused (a replaced .git/config in a live repo is
 * an RCE-adjacent write), and the Lane 3 secret policy covers .env*, key
 * material and credential homes. Pure string checks — no filesystem here.
 */
function refuseProtectedComponents(relativePath: string): void {
  for (const segment of relativePath.split('/')) {
    if (segment === '.git' || isSecretBasename(segment)) {
      throw new CollabError('invalid_input', `entry path names a protected file: ${relativePath}`);
    }
  }
}

function pick(file: { relativePath: string; sizeBytes: number; checksumSha256: string }): {
  relativePath: string; sizeBytes: number; checksumSha256: string;
} {
  return {
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
  };
}
