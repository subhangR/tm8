/**
 * W2 artifacts — versioned, viewable static-web bundles (TM8-ARTIFACTS-DESIGN
 * §8.1). Modelled on `files.ts`: a service holding the injected `W2BlobStore`,
 * whose handlers validate input server-side and drive the 055 RPCs.
 *
 * The one invariant this service exists to enforce is model-agnosticism (§3):
 * an artifact's identity is its manifest, and the manifest hash is RECOMPUTED
 * from the bytes here — never trusted from the client, never carried on the
 * wire (the manifest has no hash field). `sourceProvenance` is built entirely
 * server-side with the server clock, so a caller cannot backdate history or
 * smuggle provider/model facts into the frozen record (§6, §6.2).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  CollabError,
  manifestSha256,
  parseArtifactManifest,
  type ArtifactInlineFile,
  type ArtifactManifest,
  type ArtifactsCreateInput,
  type ArtifactsPreviewStartInput,
  type ArtifactsPublishInput,
  type ArtifactsRestoreInput,
} from '@tm8/contract';
import { ZodError } from 'zod';

import type { DbClaims } from '../../../db/types.js';
import type { Querier } from '../../../db/types.js';
import type { W2BlobStore } from '../../../files/w2-blob-store.js';
import { buildDeterministicZip } from '../../../files/zip.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import { raw } from '../../../http/types.js';
import { claimsFor, commandEnvelope, requireParam, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { toCommandResult, type RpcCommandResult } from '../../handlers/entities.js';

/**
 * Preview capability TTL (design §9.5: 10 minutes). The RPC also enforces a
 * 1..3600s band; this is the one value this node mints, never per-request.
 */
const PREVIEW_TTL_SECONDS = 600;

export interface W2ArtifactsServiceOptions {
  readonly blobStore: W2BlobStore;
  readonly now?: () => Date;
}

/**
 * The frozen `source_provenance` envelope (§6). Every key is always present;
 * a fact tm8 cannot honestly supply today is `null`, never invented or omitted
 * (§6.2). In this Phase-1 server slice only `schemaVersion`, `publishedAt`,
 * `spaceId` and `sourceWorkSessionId` are ever non-null — `launchProjectId`,
 * `associatedProjectIds`, `project`, `worktree` and `build` have no wired
 * source and are honestly null/empty.
 */
interface SourceProvenance {
  schemaVersion: 1;
  publishedAt: string;
  spaceId: string;
  sourceWorkSessionId: string | null;
  launchProjectId: string | null;
  associatedProjectIds: string[];
  project: null;
  worktree: null;
  build: null;
}

interface RevisionRow {
  revision_number: number;
  manifest_sha256: string;
  entrypoint_path: string;
  file_count: number;
  total_size_bytes: string | number;
  source_provenance: unknown;
  created_at: Date | string;
  published_by: string;
}

interface ExportEntryRow {
  path: string;
  media_type: string;
  size_bytes: string | number;
  storage_path: string;
}

interface PreviewRpcResult {
  previewSessionId: string;
  revisionNumber: number;
  expiresAt: string;
}

interface RegisterBlobRpcResult {
  blobId: string;
  storagePath: string;
  sizeBytes: string | number;
  inserted: boolean;
}

/** A blob staged on disk and registered under content addressing (§5.1). */
export interface RegisteredBlob {
  readonly blobId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storagePath: string;
  readonly inserted: boolean;
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
 * Validate a manifest through the contract's strict schema. The HTTP input
 * binding already ran this once; re-running it here keeps the service correct
 * when called directly (restore reads a stored manifest; tests call it raw) and
 * maps a schema violation to `invalid_input` rather than letting a ZodError
 * escape as a 500.
 */
function validateManifest(value: unknown): ArtifactManifest {
  try {
    return parseArtifactManifest(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const where = first && first.path.length > 0 ? ` (${first.path.join('.')})` : '';
      throw new CollabError('invalid_input', `invalid artifact manifest${where}: ${first?.message ?? 'validation failed'}`);
    }
    throw error;
  }
}

/** The RPC's `p_entries`: {path, mediaType, sizeBytes, sha256} in manifest order. */
function entriesFromManifest(manifest: ArtifactManifest): ReadonlyArray<Record<string, unknown>> {
  return manifest.files.map((file) => ({
    path: file.path,
    mediaType: file.mediaType,
    sizeBytes: file.size,
    sha256: file.sha256,
  }));
}

function requireRevisionParam(ctx: RequestContext): number {
  const value = requireParam(ctx, 'revisionNumber');
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new CollabError('invalid_input', 'revisionNumber must be a positive integer');
  }
  return n;
}

function revisionDto(row: RevisionRow): Record<string, unknown> {
  return {
    revisionNumber: Number(row.revision_number),
    manifestSha256: row.manifest_sha256,
    entrypoint: row.entrypoint_path,
    fileCount: Number(row.file_count),
    totalSizeBytes: Number(row.total_size_bytes),
    sourceProvenance: row.source_provenance ?? null,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    publishedBy: row.published_by,
  };
}

function zipFilename(name: string, revisionNumber: number): string {
  const base = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/]/g, '_').trim().slice(0, 80) || 'artifact';
  return `${base}-r${revisionNumber}.zip`;
}

// The deterministic zip writer moved to `files/zip.ts` when folder download
// became a second caller (design §9.6 choices unchanged; this service's
// byte-equality test is the guard that the lift changed nothing).

export class W2ArtifactsService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2ArtifactsServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private buildProvenance(spaceId: string, sourceWorkSessionId: string | null): SourceProvenance {
    return {
      schemaVersion: 1,
      publishedAt: this.now().toISOString(),
      spaceId,
      sourceWorkSessionId,
      launchProjectId: null,
      associatedProjectIds: [],
      project: null,
      worktree: null,
      build: null,
    };
  }

  private async requestClaims(
    ctx: RequestContext,
    envelope: ReturnType<typeof commandEnvelope> = {},
  ): Promise<{ claims: DbClaims; viewerIdentityId: string }> {
    const owner = await this.deps.owner();
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

  /** The artifact's space, or `not_found` when the entity is absent/invisible. */
  private async artifactSpaceId(q: Querier, id: string): Promise<string> {
    const rows = await q.query<{ space_id: string }>(
      `select space_id from public.entities
        where id = $1 and kind = 'artifact' and deleted_at is null`,
      [id],
    );
    if (!rows[0]) throw new CollabError('not_found', `no such artifact: ${id}`);
    return rows[0].space_id;
  }

  readonly create: OperationHandler = async (ctx) => {
    const input = ctx.body as ArtifactsCreateInput;
    const manifest = validateManifest(input.manifest);
    const hash = manifestSha256(manifest);
    const entries = entriesFromManifest(manifest);
    const envelope = commandEnvelope(ctx);
    const { claims, viewerIdentityId } = await this.requestClaims(ctx, envelope);
    await this.stageInlineFiles(claims, input.spaceId, manifest, input.files);
    const provenance = this.buildProvenance(input.spaceId, input.sourceWorkSessionId ?? null);
    return this.deps.db.tx(claims, async (q) => {
      const rpc = await q.rpc<RpcCommandResult>('create_artifact', [
        input.spaceId,
        input.name,
        input.description ?? null,
        JSON.stringify(manifest),
        hash,
        manifest.entrypoint,
        JSON.stringify(entries),
        JSON.stringify(provenance),
        input.sourceWorkSessionId ?? null,
        envelope.actorId ?? null,
        input.parentId ?? null,
        input.position ?? null,
        input.clientMutationId,
      ]);
      return toCommandResult(q, rpc, viewerIdentityId);
    });
  };

  readonly publish: OperationHandler = async (ctx) => {
    const artifactId = requireUuidParam(ctx, 'artifactId');
    const input = ctx.body as ArtifactsPublishInput;
    const manifest = validateManifest(input.manifest);
    const hash = manifestSha256(manifest);
    const entries = entriesFromManifest(manifest);
    const envelope = commandEnvelope(ctx);
    const { claims, viewerIdentityId } = await this.requestClaims(ctx, envelope);
    if (input.files?.length) {
      const spaceForStaging = await this.deps.db.tx(claims, (q) => this.artifactSpaceId(q, artifactId));
      await this.stageInlineFiles(claims, spaceForStaging, manifest, input.files);
    }
    return this.deps.db.tx(claims, async (q) => {
      const spaceId = await this.artifactSpaceId(q, artifactId);
      const provenance = this.buildProvenance(spaceId, input.sourceWorkSessionId ?? null);
      const rpc = await q.rpc<RpcCommandResult>('publish_artifact_revision', [
        artifactId,
        input.expectedVersion,
        JSON.stringify(manifest),
        hash,
        manifest.entrypoint,
        JSON.stringify(entries),
        JSON.stringify(provenance),
        input.sourceWorkSessionId ?? null,
        envelope.actorId ?? null,
        input.clientMutationId,
      ]);
      return toCommandResult(q, rpc, viewerIdentityId);
    });
  };

  readonly revisionsList: OperationHandler = async (ctx) => {
    const artifactId = requireUuidParam(ctx, 'artifactId');
    const { claims } = await this.requestClaims(ctx);
    return this.deps.db.tx(claims, async (q) => {
      // Resolve visibility first so a cross-space read is `not_found`, not an
      // empty list that reads as "no revisions".
      await this.artifactSpaceId(q, artifactId);
      const rows = await q.query<RevisionRow>(
        `select revision_number, manifest_sha256, entrypoint_path, file_count,
                total_size_bytes, source_provenance, created_at, published_by
           from public.artifact_bundle_revisions
          where artifact_entity_id = $1
          order by revision_number desc`,
        [artifactId],
      );
      return { revisions: rows.map(revisionDto) };
    });
  };

  readonly previewStart: OperationHandler = async (ctx) => {
    const artifactId = requireUuidParam(ctx, 'artifactId');
    const input = ctx.body as ArtifactsPreviewStartInput;
    const envelope = commandEnvelope(ctx);
    const { claims, viewerIdentityId } = await this.requestClaims(ctx, envelope);
    // A random 32-byte capability; only its sha256 is ever stored (§5.2), so a
    // database read never yields a usable credential.
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const result = await this.deps.db.rpc<PreviewRpcResult>(claims, 'start_artifact_preview', [
      artifactId,
      input.revisionNumber ?? null,
      tokenHash,
      viewerIdentityId,
      PREVIEW_TTL_SECONDS,
      envelope.actorId ?? null,
      input.clientMutationId,
    ]);
    // A ledger replay returns the ORIGINAL session id — bound to the original
    // call's token hash, not this call's fresh token. While no listener
    // existed that was harmless; now it would mint a URL that can never
    // authenticate. Detected by reading the row's stored hash back: a
    // mismatch is a replay, and the honest answer is a conflict naming the
    // fix, not a dead capability that 404s ten seconds later.
    const stored = await this.deps.db.query<{ token_hash: string }>(
      claims,
      `select token_hash from public.artifact_preview_sessions where id = $1`,
      [result.previewSessionId],
    );
    if (stored[0] && stored[0].token_hash !== tokenHash) {
      throw new CollabError(
        'conflict',
        `clientMutationId ${JSON.stringify(input.clientMutationId)} already started a preview; ` +
          'its capability token was issued once and cannot be re-derived — retry with a fresh clientMutationId',
      );
    }
    // `previewUrl` exists only when this node runs the second-origin listener
    // (design §9.2/§9.3; ratified 2026-07-31). Absent one, the capability is
    // still minted and the URL is honestly absent — never fabricated.
    const previewOrigin = this.deps.config.preview?.origin;
    return {
      previewSessionId: result.previewSessionId,
      token,
      revisionNumber: result.revisionNumber,
      expiresAt: result.expiresAt,
      ...(previewOrigin
        ? { previewUrl: `${previewOrigin}/p/${result.previewSessionId}/${token}/` }
        : {}),
    };
  };

  readonly export: OperationHandler = async (ctx) => {
    const artifactId = requireUuidParam(ctx, 'artifactId');
    const revisionNumber = requireRevisionParam(ctx);
    const { claims } = await this.requestClaims(ctx);
    const { spaceId, name, entries } = await this.deps.db.tx(claims, async (q) => {
      const artRows = await q.query<{ space_id: string; name: string }>(
        `select e.space_id, a.name
           from public.entities e
           join public.artifacts a on a.entity_id = e.id
          where e.id = $1 and e.kind = 'artifact' and e.deleted_at is null`,
        [artifactId],
      );
      const art = artRows[0];
      if (!art) throw new CollabError('not_found', `no such artifact: ${artifactId}`);
      const revRows = await q.query<{ id: string }>(
        `select id from public.artifact_bundle_revisions
          where artifact_entity_id = $1 and revision_number = $2`,
        [artifactId, revisionNumber],
      );
      const rev = revRows[0];
      if (!rev) throw new CollabError('not_found', `no such artifact revision: ${revisionNumber}`);
      // Ordered by ordinal == manifest (canonical) order. Blobs are joined by id,
      // never by a client-influenced path — there is no traversal surface here.
      const entryRows = await q.query<ExportEntryRow>(
        `select en.path, en.media_type, en.size_bytes, b.storage_path
           from public.artifact_bundle_entries en
           join public.stored_blobs b on b.id = en.blob_id
          where en.revision_id = $1
          order by en.ordinal asc`,
        [rev.id],
      );
      return { spaceId: art.space_id, name: art.name, entries: entryRows };
    });

    const files: Array<{ path: string; bytes: Buffer }> = [];
    for (const entry of entries) {
      const bytes = await this.options.blobStore.read(entry.storage_path, spaceId);
      files.push({ path: entry.path, bytes });
    }
    const zip = buildDeterministicZip(files);
    return raw(200, {
      'content-type': 'application/zip',
      'content-length': String(zip.length),
      'content-disposition': `attachment; filename="${zipFilename(name, revisionNumber)}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    }, zip);
  };

  readonly restore: OperationHandler = async (ctx) => {
    const artifactId = requireUuidParam(ctx, 'artifactId');
    const input = ctx.body as ArtifactsRestoreInput;
    const envelope = commandEnvelope(ctx);
    const { claims, viewerIdentityId } = await this.requestClaims(ctx, envelope);
    return this.deps.db.tx(claims, async (q) => {
      const rows = await q.query<{ space_id: string; manifest: unknown }>(
        `select e.space_id, r.manifest
           from public.entities e
           join public.artifact_bundle_revisions r on r.artifact_entity_id = e.id
          where e.id = $1 and e.kind = 'artifact' and e.deleted_at is null
            and r.revision_number = $2`,
        [artifactId, input.revisionNumber],
      );
      const src = rows[0];
      if (!src) throw new CollabError('not_found', `no such artifact revision: ${input.revisionNumber}`);
      // Restore republishes revision N's exact bytes as a NEW revision, with
      // fresh server-built provenance (design §2.3: revisions are append-only,
      // never mutated). The §6 envelope carries no "restored from" field, so the
      // append-only revision row and its activity are the record of the event.
      const manifest = validateManifest(src.manifest);
      const hash = manifestSha256(manifest);
      const entries = entriesFromManifest(manifest);
      const provenance = this.buildProvenance(src.space_id, null);
      const rpc = await q.rpc<RpcCommandResult>('publish_artifact_revision', [
        artifactId,
        input.expectedVersion,
        JSON.stringify(manifest),
        hash,
        manifest.entrypoint,
        JSON.stringify(entries),
        JSON.stringify(provenance),
        null,
        envelope.actorId ?? null,
        input.clientMutationId,
      ]);
      return toCommandResult(q, rpc, viewerIdentityId);
    });
  };

  /**
   * Stage `bytes` on disk in the frozen `spaces/<spaceId>/<uuid>` shape and
   * register them under content addressing (§5.1). Blobs reach `stored_blobs`
   * only through `register_stored_blob`; `create`/`publish` then accept a
   * manifest whose sha256s are already registered (an unknown blob is the RPC's
   * `22023` → `invalid_input`). Idempotent on `(space, sha256)`: a duplicate
   * upload returns the canonical row and the redundant staged file is removed.
   */
  /**
   * The Phase-1 wire path for bundle bytes: inline base64 files on
   * create/publish (bounded by the request body cap, tighter than the 25 MiB
   * bundle cap — larger bundles await the Phase-2 batch upload grants).
   * Every inline file must name a manifest entry, and the decoded bytes must
   * hash and size to exactly what that entry declares — verified here, so a
   * lying client is refused before anything touches disk ordering concerns.
   * Entries with no inline file are legal: their blobs must already be
   * registered, or the RPC refuses with unknown_blob.
   */
  private async stageInlineFiles(
    claims: DbClaims,
    spaceId: string,
    manifest: ArtifactManifest,
    files: readonly ArtifactInlineFile[] | undefined,
  ): Promise<void> {
    if (!files || files.length === 0) return;
    const entriesByPath = new Map(manifest.files.map((f) => [f.path, f]));
    for (const file of files) {
      const entry = entriesByPath.get(file.path);
      if (!entry) {
        throw new CollabError('invalid_input', `inline file ${JSON.stringify(file.path)} is not in the manifest`);
      }
      const bytes = Buffer.from(file.contentBase64, 'base64');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== entry.sha256 || bytes.length !== entry.size) {
        throw new CollabError(
          'invalid_input',
          `inline file ${JSON.stringify(file.path)} does not match its manifest entry ` +
            `(declared sha256 ${entry.sha256}/${String(entry.size)}B, got ${sha256}/${String(bytes.length)}B)`,
        );
      }
      await this.registerBlobBytes(claims, spaceId, bytes);
    }
  }

  async registerBlobBytes(claims: DbClaims, spaceId: string, bytes: Buffer): Promise<RegisteredBlob> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sizeBytes = bytes.length;
    const blobId = randomUUID();
    const storagePath = this.options.blobStore.storagePath(spaceId, blobId);
    await this.options.blobStore.writeUpload({
      stream: (async function* () { yield bytes; })(),
      storagePath,
      expectedSpaceId: spaceId,
      expectedSizeBytes: sizeBytes,
      expectedChecksumSha256: sha256,
    });
    const result = await this.deps.db.rpc<RegisterBlobRpcResult>(claims, 'register_stored_blob', [
      spaceId,
      sha256,
      sizeBytes,
      storagePath,
      null,
    ]);
    if (!result.inserted && result.storagePath !== storagePath) {
      // A duplicate: the canonical row's storage_path wins. Discard the
      // redundant staged file rather than leave it orphaned on disk.
      await this.options.blobStore.remove(storagePath, spaceId).catch(() => undefined);
    }
    return {
      blobId: result.blobId,
      sha256,
      sizeBytes: Number(result.sizeBytes),
      storagePath: result.storagePath,
      inserted: result.inserted,
    };
  }
}

export type { RevisionRow, ExportEntryRow, PreviewRpcResult };
