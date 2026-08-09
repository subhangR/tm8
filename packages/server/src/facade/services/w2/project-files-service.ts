import { createHash, randomUUID } from 'node:crypto';

import {
  CollabError,
  FILE_MAX_SIZE_BYTES_DEFAULT,
  type ProjectFileAttachInput,
  type ProjectFileContent,
  type ProjectFileListing,
} from '@tm8/contract';

import type { DbClaims } from '../../../db/types.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { W2BlobStore } from '../../../files/w2-blob-store.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { toCommandResult, type RpcCommandResult } from '../../handlers/entities.js';
import {
  listProjectFiles,
  projectFileStream,
  readProjectFile,
  resolveProjectFile,
} from './project-files.js';

/** Matches files.uploadInit — the slot this service opens is the same slot. */
const UPLOAD_TTL_MS = 15 * 60 * 1_000;

interface WorkingDirRow {
  working_dir: string;
}

interface InitRpcResult {
  uploadId: string;
  storagePath: string;
  expiresAt: string;
  maxSizeBytes: number;
}

interface AuthorizeRpcResult {
  outcome: 'authorized' | 'staged' | 'completed' | 'aborted' | 'expired';
  storagePath: string;
  spaceId: string;
}

interface SettleRpcResult {
  outcome: 'staged' | 'aborted' | 'expired';
}

interface CompleteRpcResult extends RpcCommandResult {
  outcome: 'completed' | 'aborted' | 'expired' | 'pending';
  storagePath: string;
  spaceId: string;
}

export interface W2ProjectFilesServiceOptions {
  readonly blobStore: W2BlobStore;
  /** Effective deployment ceiling; must not exceed the injected blob store's. */
  readonly maxSizeBytes?: number;
  readonly now?: () => Date;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * One caller id, one id per ledger stage — DEV-9's rule is that a
 * clientMutationId belongs to exactly ONE operation, and this attach spans two
 * of them (`files.uploadInit` and `files.uploadComplete`). Passing the caller's
 * id to both is refused by the ledger with `invariant_violation`, which is the
 * correct answer: they are different commands and must be separately
 * replayable.
 *
 * The derivation is deterministic, so a retry of the same caller id replays
 * both stages rather than opening a second slot. It is byte-identical to the
 * CLI's `deriveMutationId` (packages/cli/src/mutation.ts), which composes the
 * same three-stage upload — copied rather than imported because `contract` is
 * the only permitted cross-package dependency.
 */
function deriveMutationId(rootId: string, stage: string): string {
  const digest = createHash('sha256').update(`tm8/mutation/${rootId}/${stage}`).digest();
  const bytes = new Uint8Array(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80; // version 8 — custom/derived
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const h = Buffer.from(bytes).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Mirrors the files lane: the identity that opens a slot must also settle it. */
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
 * Read files out of a connected project folder, and attach one to the graph.
 *
 * The attach path deliberately drives the SAME `w2_*_file_upload` ledger the
 * browser upload uses — init, authorize, write, settle, complete — with the
 * byte source swapped from an HTTP request to a node-local read stream. That
 * is what keeps one set of invariants: mutation-id replay, the frozen target
 * set, the size ceiling, and the checksum re-verification inside the blob
 * store all behave identically whichever way a file arrived.
 */
export class W2ProjectFilesService {
  private readonly now: () => Date;
  private readonly maxSizeBytes: number;

  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2ProjectFilesServiceOptions,
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

  readonly listFiles: OperationHandler = async (ctx) => {
    const projectId = requireUuidParam(ctx, 'projectId');
    const { workingDir } = await this.project(ctx, projectId);
    const listing = await listProjectFiles(
      workingDir,
      ctx.query.get('path') ?? undefined,
      this.maxSizeBytes,
    );
    return { projectId, ...listing } satisfies ProjectFileListing;
  };

  /**
   * The VIEWER half of `listFiles`. Shares its authorization (`this.project`)
   * and its containment, and mints nothing — reading a file creates no entity.
   *
   * A withholding rides IN the DTO as a named `refusal`, not as an HTTP error:
   * the caller asked a legitimate question and deserves a named answer rather
   * than a 4xx an offline client cannot tell from a network fault.
   */
  readonly readFile: OperationHandler = async (ctx) => {
    const projectId = requireUuidParam(ctx, 'projectId');
    const path = ctx.query.get('path');
    if (!path) {
      throw new CollabError('invalid_input', 'path is required');
    }
    const { workingDir } = await this.project(ctx, projectId);
    return { projectId, ...(await readProjectFile(workingDir, path)) } satisfies ProjectFileContent;
  };

  readonly attachFile: OperationHandler = async (ctx) => {
    const projectId = requireUuidParam(ctx, 'projectId');
    const input = ctx.body as ProjectFileAttachInput;
    const { workingDir, claims, viewerIdentityId } = await this.project(ctx, projectId);
    const file = await resolveProjectFile(workingDir, input.path, this.maxSizeBytes);

    const envelope = commandEnvelope(ctx);
    const name = input.name ?? file.name;
    const mime = input.mime ?? file.mime;
    const uploadId = randomUUID();
    const storageBlobId = randomUUID();
    const grant = tokenHash(await this.options.blobStore.grantToken(uploadId));
    const expiresAt = new Date(this.now().getTime() + UPLOAD_TTL_MS);

    // The ledger refuses a replayed mutation id whose request hash differs, so
    // this must cover everything that shapes the resulting file — including the
    // digest, which makes a retry after the file changed on disk a conflict
    // rather than a silent second version.
    const requestHash = hashJson({
      spaceId: input.spaceId,
      actorId: envelope.actorId ?? null,
      name,
      mime,
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
      entityId: null,
      maxSizeBytes: this.maxSizeBytes,
    });

    const slot = await this.deps.db.rpc<InitRpcResult>(claims, 'w2_init_file_upload', [
      uploadId,
      input.spaceId,
      envelope.actorId ?? null,
      name,
      mime,
      file.sizeBytes,
      file.checksumSha256,
      storageBlobId,
      grant,
      expiresAt.toISOString(),
      null,
      this.maxSizeBytes,
      deriveMutationId(input.clientMutationId, 'files.uploadInit'),
      requestHash,
    ]);

    // A replayed mutation id returns the ORIGINAL upload id, whose token — and
    // therefore whose lease hash — is derived from that id, not from ours.
    const settledUploadId = slot.uploadId;
    const settledGrant = tokenHash(await this.options.blobStore.grantToken(settledUploadId));
    await this.stageBytes(claims, settledUploadId, settledGrant, file, input.spaceId);

    const settled = await this.deps.db.tx(claims, async (q) => {
      const result = await q.rpc<CompleteRpcResult>('w2_complete_file_upload', [
        settledUploadId,
        file.sizeBytes,
        file.checksumSha256,
        deriveMutationId(input.clientMutationId, 'files.uploadComplete'),
        input.targets ?? [],
      ]);
      if (result.outcome !== 'completed') return { result };
      return { result, command: await toCommandResult(q, result, viewerIdentityId) };
    });

    if (settled.result.outcome === 'completed' && settled.command) return settled.command;
    await this.options.blobStore
      .remove(settled.result.storagePath, settled.result.spaceId)
      .catch(() => undefined);
    throw new CollabError('invalid_input', `upload slot is ${settled.result.outcome}`);
  };

  /**
   * Take the writer lease, stream the file into the blob store, and settle.
   * `staged` on authorize means a previous attempt already wrote these bytes,
   * so the write is skipped and completion proceeds — the retry-safe path.
   */
  private async stageBytes(
    claims: DbClaims,
    uploadId: string,
    grant: string,
    file: Awaited<ReturnType<typeof resolveProjectFile>>,
    spaceId: string,
  ): Promise<void> {
    const leaseId = randomUUID();
    const authorized = await this.deps.db.rpc<AuthorizeRpcResult>(
      claims,
      'w2_authorize_file_upload',
      [uploadId, grant, leaseId],
    );
    // `staged` means a previous attempt already wrote these bytes. `completed`
    // means the whole attach already succeeded — the caller is retrying a
    // mutation id that has run to the end, and the right answer is to fall
    // through to `w2_complete_file_upload`, whose own ledger replay returns the
    // original result. Refusing here would turn every honest retry into a 400.
    if (authorized.outcome === 'staged' || authorized.outcome === 'completed') return;
    if (authorized.outcome === 'expired') {
      await this.options.blobStore.remove(authorized.storagePath, authorized.spaceId).catch(() => undefined);
      throw new CollabError('invalid_input', 'upload slot has expired');
    }
    if (authorized.outcome !== 'authorized') {
      throw new CollabError('invalid_input', `upload slot is ${authorized.outcome}`);
    }

    try {
      await this.options.blobStore.writeUpload({
        stream: projectFileStream(file.path),
        storagePath: authorized.storagePath,
        expectedSpaceId: spaceId,
        expectedSizeBytes: file.sizeBytes,
        expectedChecksumSha256: file.checksumSha256,
      });
    } catch (error) {
      await this.deps.db
        .rpc<SettleRpcResult>(claims, 'w2_settle_file_upload_write', [uploadId, grant, leaseId, false, null, null])
        .catch(() => undefined);
      throw error;
    }

    const settled = await this.deps.db.rpc<SettleRpcResult>(
      claims,
      'w2_settle_file_upload_write',
      [uploadId, grant, leaseId, true, file.sizeBytes, file.checksumSha256],
    );
    if (settled.outcome !== 'staged') {
      await this.options.blobStore.remove(authorized.storagePath, spaceId).catch(() => undefined);
      throw new CollabError('invalid_input', `upload slot is ${settled.outcome}`);
    }
  }

  /**
   * Resolve the project's configured directory under the caller's own claims,
   * so an unreadable project is `not_found` before any filesystem work starts.
   * Node-admin is required on top: reading node-local bytes into a Space is at
   * least as privileged as browsing the node's directories.
   */
  private async project(ctx: RequestContext, projectId: string): Promise<{
    workingDir: string;
    claims: DbClaims;
    viewerIdentityId: string;
  }> {
    const owner = await this.deps.owner();
    const viewerIdentityId = requireAuthenticatedIdentity(ctx, owner.identityId);
    const base = claimsFor(owner, ctx, commandEnvelope(ctx));
    const claims: DbClaims = {
      ...base,
      identityId: viewerIdentityId,
      nodeAdmin: viewerIdentityId === owner.identityId ? owner.isNodeAdmin : false,
    };
    if (claims.nodeAdmin !== true) {
      throw new CollabError('forbidden', 'node-admin access is required to read project files');
    }
    const rows = await this.deps.db.query<WorkingDirRow>(
      claims,
      `select working_dir from public.projects where id = $1`,
      [projectId],
    );
    const row = rows[0];
    if (!row) throw new CollabError('not_found', `no such project: ${projectId}`);
    return { workingDir: row.working_dir, claims, viewerIdentityId };
  }
}
