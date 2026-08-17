/**
 * `tm8 artifact …` — versioned, viewable static-web bundles (TM8-ARTIFACTS-DESIGN
 * §8.2).
 *
 * SIX COMMANDS OVER SIX CATALOG ROWS, AND ONE OF THEM IS COMPOSED. `artifact
 * publish` is a COMPOSED command in the `file upload` sense: one caller-visible
 * invocation that walks a directory, builds and hashes the strict,
 * model-agnostic manifest (`@tm8/contract`'s artifact-manifest module), and then
 * calls EITHER `artifacts.create` (a brand-new artifact) OR `artifacts.publish`
 * (a further revision of `--artifact`, under `--expect-version`). Both catalog
 * rows map to the ONE command path `artifact publish`, exactly as
 * `files.uploadInit` and `files.uploadComplete` share `file upload`. Registering
 * them as two paths would not fail one test — `commands/registry.ts` throws at
 * import on a duplicate path and would take down the whole suite.
 *
 * MODEL AGNOSTICISM IS THE CONTRACT'S, NOT OURS TO RE-DERIVE. The manifest shape,
 * its strict validation, the NFC/sort/dedup path rules, JCS canonicalisation and
 * the content hash all live in `@tm8/contract`. This file constructs the manifest
 * from files on disk and hands it to `parseArtifactManifest`; it never invents a
 * second copy of those rules. Identical bytes produce an identical manifest hash
 * regardless of who or what produced the bundle (§3).
 *
 * THE BYTES TRAVEL INLINE WITH THE MANIFEST. The create/publish RPCs reference
 * blobs by the `sha256` inside the manifest; the server resolves those against
 * `stored_blobs`, and `files: [{path, contentBase64}]` in the same body stages
 * any blob it has not seen before. The bytes sent are the SAME buffers that were
 * hashed — a file changing on disk between hash and send still produces a
 * coherent request, and the server recomputes every hash rather than trusting
 * the wire. Inline base64 inflates the request 4/3, so the server's request-body
 * cap (`TM8_MAX_BODY_BYTES`, default 8 MiB) bounds a publish well below the
 * manifest's 25 MiB total: the preflight in `buildManifest` refuses an oversized
 * bundle here, with the effective cap named, instead of letting it die as an
 * opaque 413. Batch blob upload (Phase 2) will lift that ceiling.
 *
 * `artifact export` answers RAW ZIP BYTES (§9.6) — the documented bytes exception
 * this client already models for `file download`. Bytes and structured output are
 * mutually exclusive on stdout, so `--out <path>` writes the zip there and leaves
 * stdout empty. `artifact preview` PRINTS what the Server returns and opens
 * nothing: a CLI opening a browser would be an outward-facing side effect the
 * caller did not ask for. The Server returns a `previewUrl` when the node has a
 * preview origin configured; it is printed verbatim, never fabricated.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACT_MANIFEST_SCHEMA_ID,
  ARTIFACT_MAX_FILES,
  ARTIFACT_MAX_FILE_BYTES,
  ARTIFACT_MAX_TOTAL_BYTES,
  ARTIFACT_RUNTIME_ID,
  manifestSha256,
  parseArtifactManifest,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactMediaType,
  type OperationName,
} from '@tm8/contract';
import { requireSpace } from '../context.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { ledger } from '../discovery/availability.js';
import { assertKnownOptions, requireArg, summaryLine, withActor } from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

/**
 * Extension → allowlisted media type. The VALUES are the contract's frozen
 * `ARTIFACT_MEDIA_TYPES`; this map only names which file extensions produce
 * them. An unknown extension is exit 2 with the file named — declared metadata
 * served verbatim beside `nosniff` means a wrong type cannot upgrade a `.txt`
 * into script, so guessing is refused rather than defaulted.
 */
const MEDIA_TYPE_BY_EXT: Readonly<Record<string, ArtifactMediaType>> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json', // a JS source map is application/json (contract §4.2)
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain',
};

const DEFAULT_ENTRYPOINT = 'index.html';

/**
 * The server refuses request bodies over `TM8_MAX_BODY_BYTES` (default 8 MiB)
 * before any handler runs. The CLI cannot read the server's env, so it assumes
 * the default; a node configured lower will still 413, one configured higher
 * needs Phase 2's batch blob upload anyway.
 */
const SERVER_DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Headroom for the non-`files` body fields (manifest is measured separately). */
const INLINE_BODY_SLACK_BYTES = 64 * 1024;

/** One inline blob, exactly as `artifacts.create`/`artifacts.publish` accept it. */
interface InlineFile {
  path: string;
  contentBase64: string;
}

interface WalkedFile {
  /** POSIX-separated path relative to the published directory, NFC-normalised. */
  path: string;
  absPath: string;
  size: number;
}

/** UTF-8 byte-sequence comparison — the manifest's required sort order (§4.1). */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function mediaTypeFor(path: string): ArtifactMediaType {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  const media = MEDIA_TYPE_BY_EXT[ext];
  if (media === undefined) {
    throw new CliError(
      `${JSON.stringify(path)} has an extension with no allowlisted media type`,
      EXIT_USAGE,
      { hint: `allowed extensions: ${Object.keys(MEDIA_TYPE_BY_EXT).sort().join(', ')}` },
    );
  }
  return media;
}

/**
 * Collect the regular files under `root`. Dot-prefixed entries (`.git`,
 * `.DS_Store`, …) are skipped rather than published: the manifest rejects any
 * path segment beginning with `.`, so including one would fail every publish
 * from a macOS or git working tree. Symlinks are skipped — a bundle is its own
 * bytes, not a pointer elsewhere.
 */
function walk(root: string): { files: WalkedFile[]; skippedHidden: string[] } {
  const files: WalkedFile[] = [];
  const skippedHidden: string[] = [];
  const recurse = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new CliError(
        `cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        EXIT_USAGE,
      );
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        skippedHidden.push(prefix + entry.name);
        continue;
      }
      const abs = join(dir, entry.name);
      const rel = (prefix + entry.name).normalize('NFC');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) recurse(abs, `${rel}/`);
      else if (entry.isFile()) files.push({ path: rel, absPath: abs, size: statSync(abs).size });
    }
  };
  recurse(root, '');
  return { files, skippedHidden };
}

/**
 * Walk, enforce the contract's limits locally, hash each file, and build the
 * manifest — then validate it with the contract's own strict parser so an
 * unsorted, duplicate, non-NFC, or bad-entrypoint bundle is refused HERE with a
 * concrete reason rather than as an opaque server 400. The returned `files` are
 * the inline blobs for the create/publish body, encoded from the SAME buffers
 * the manifest hashes were computed from and keyed by the manifest's own
 * NFC-normalised paths, so hash, size, and bytes can never disagree on the wire.
 */
function buildManifest(
  cmd: CommandContext,
  dir: string,
): { manifest: ArtifactManifest; totalBytes: number; inlineFiles: InlineFile[] } {
  if (!existsSync(dir)) {
    throw new CliError(`${dir} does not exist`, EXIT_USAGE, {
      hint: 'pass the directory whose files make up the bundle',
    });
  }
  if (!statSync(dir).isDirectory()) {
    throw new CliError(`${dir} is not a directory`, EXIT_USAGE);
  }

  const { files, skippedHidden } = walk(dir);
  if (skippedHidden.length > 0) {
    cmd.out.note(`skipped ${skippedHidden.length} dot-prefixed path(s): ${skippedHidden.sort().join(', ')}`);
  }
  if (files.length === 0) {
    throw new CliError(`${dir} contains no publishable files`, EXIT_USAGE, {
      hint: 'a bundle needs at least one file; dot-prefixed and symlinked entries are skipped',
    });
  }
  if (files.length > ARTIFACT_MAX_FILES) {
    throw new CliError(
      `bundle has ${files.length} files; the limit is ${ARTIFACT_MAX_FILES}`,
      EXIT_USAGE,
    );
  }

  let totalBytes = 0;
  const contentBase64ByPath = new Map<string, string>();
  const entries: ArtifactManifestFile[] = files.map((file) => {
    if (file.size > ARTIFACT_MAX_FILE_BYTES) {
      throw new CliError(
        `${file.path} is ${file.size} bytes; the per-file limit is ${ARTIFACT_MAX_FILE_BYTES}`,
        EXIT_USAGE,
      );
    }
    const bytes = readFileSync(file.absPath);
    // The manifest declares the HASHED buffer's length, and the same buffer is
    // what travels — a file mutating on disk mid-publish cannot desync the two.
    totalBytes += bytes.length;
    contentBase64ByPath.set(file.path, bytes.toString('base64'));
    return {
      path: file.path,
      mediaType: mediaTypeFor(file.path),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  if (totalBytes > ARTIFACT_MAX_TOTAL_BYTES) {
    throw new CliError(
      `bundle is ${totalBytes} bytes; the total limit is ${ARTIFACT_MAX_TOTAL_BYTES}`,
      EXIT_USAGE,
    );
  }

  entries.sort((a, b) => compareUtf8(a.path, b.path));

  const entrypoint = (cmd.options.value('entrypoint') ?? DEFAULT_ENTRYPOINT).normalize('NFC');
  if (!entries.some((entry) => entry.path === entrypoint)) {
    throw new CliError(
      `--entrypoint ${JSON.stringify(entrypoint)} is not one of the bundle files`,
      EXIT_USAGE,
      { hint: `bundle files: ${entries.map((e) => e.path).join(', ')}` },
    );
  }

  const draft = {
    schema: ARTIFACT_MANIFEST_SCHEMA_ID,
    runtime: ARTIFACT_RUNTIME_ID,
    entrypoint,
    files: entries,
  };
  let manifest: ArtifactManifest;
  try {
    manifest = parseArtifactManifest(draft);
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'issues' in err
        ? (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')
        : err instanceof Error
          ? err.message
          : String(err);
    throw new CliError(`the bundle manifest is invalid: ${message}`, EXIT_USAGE);
  }

  // The blobs ride inline in the same request body, keyed by the manifest's
  // validated (NFC-normalised, sorted) paths so the server's path lookup and
  // hash recomputation both match.
  const inlineFiles: InlineFile[] = manifest.files.map((entry) => ({
    path: entry.path,
    contentBase64: contentBase64ByPath.get(entry.path) as string,
  }));

  // Preflight the server's request-body cap: base64 inflates 4/3, so the real
  // inline ceiling is well under the manifest's own total limit. Measure the
  // dominant body parts exactly rather than estimating.
  const measuredBytes =
    Buffer.byteLength(JSON.stringify({ manifest, files: inlineFiles }), 'utf8') +
    INLINE_BODY_SLACK_BYTES;
  if (measuredBytes > SERVER_DEFAULT_MAX_BODY_BYTES) {
    const effectiveRawCap = Math.floor(
      ((SERVER_DEFAULT_MAX_BODY_BYTES - INLINE_BODY_SLACK_BYTES) * 3) / 4,
    );
    throw new CliError(
      `bundle is ${totalBytes} bytes, which base64-encodes past the server's ` +
        `${SERVER_DEFAULT_MAX_BODY_BYTES}-byte request-body cap; the effective bundle ` +
        `limit for inline publish is about ${effectiveRawCap} bytes`,
      EXIT_USAGE,
      {
        hint:
          'larger bundles need batch blob upload, which is not implemented yet (Artifacts Phase 2); ' +
          'shrink the bundle for now',
      },
    );
  }

  return { manifest, totalBytes, inlineFiles };
}

// ── the composed publish ─────────────────────────────────────────────────────

async function artifactPublish(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [
    'space', 'name', 'description', 'entrypoint', 'artifact', 'expect-version', 'mutation-id',
  ]);
  const dir = requireArg(cmd, 0, '<dir>');

  const artifactId = cmd.options.value('artifact');
  const expectedVersion = cmd.options.integer('expect-version');
  // `--artifact` and `--expect-version` are mandatory TOGETHER (§8.1): one
  // selects the existing artifact, the other guards the revision it publishes
  // against. Either alone is a request the wire cannot answer.
  if ((artifactId === undefined) !== (expectedVersion === undefined)) {
    throw new CliError(
      '`--artifact` and `--expect-version` must be given together, or neither',
      EXIT_USAGE,
      { hint: 'with both, this publishes a further revision of an existing artifact; with neither, it creates a new one' },
    );
  }

  const { manifest, totalBytes, inlineFiles } = buildManifest(cmd, dir);
  const contentHash = manifestSha256(manifest);
  cmd.out.note(
    `manifest: ${manifest.files.length} file(s), ${totalBytes} bytes, entrypoint ${manifest.entrypoint}, sha256 ${contentHash}`,
  );

  const client = clientFor(cmd.ctx);
  const clientMutationId = resolveMutationId(cmd.options.value('mutation-id'));

  if (artifactId !== undefined) {
    if (expectedVersion === undefined || expectedVersion <= 0) {
      throw new CliError('--expect-version expects a positive version', EXIT_USAGE);
    }
    const body = withActor(cmd, { clientMutationId, expectedVersion, manifest, files: inlineFiles });
    const data = await observedInvoke<unknown>(client, 'artifacts.publish', {
      params: { artifactId },
      body,
    });
    cmd.out.data(data, renderArtifactMutation);
    return EXIT_OK;
  }

  const spaceId = requireSpace(cmd.ctx);
  const name = cmd.options.value('name') ?? basenameOf(dir);
  if (name.trim().length === 0) {
    throw new CliError('tm8 artifact publish requires --name <name>', EXIT_USAGE, {
      hint: 'the directory name could not be used as an artifact name',
    });
  }
  const body: Record<string, unknown> = { clientMutationId, spaceId, name, manifest, files: inlineFiles };
  const description = cmd.options.value('description');
  if (description !== undefined) body.description = description;

  const data = await observedInvoke<unknown>(client, 'artifacts.create', {
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderArtifactMutation);
  return EXIT_OK;
}

/** The trailing path segment of `dir`, used as a fallback artifact name. */
function basenameOf(dir: string): string {
  const trimmed = dir.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

// ── reads ────────────────────────────────────────────────────────────────────
// NO `artifact get`: reads reuse the generic surface (T-L12 — the design's own
// rule for the API applies to the grammar too). `tm8 entity get <artifact-id>`
// answers it; an `artifact get` alias would be a registered command with no
// discovery row, the exact unprojected class discovery-commands.test.ts exists
// to refuse.

async function artifactRevisions(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('artifact revisions', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, []);
  const artifactId = requireArg(cmd, 0, '<artifact-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'artifacts.revisions.list', {
    params: { artifactId },
  });
  cmd.out.data(data, renderRevisions);
  return EXIT_OK;
}

async function artifactPreview(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['revision', 'mutation-id']);
  const artifactId = requireArg(cmd, 0, '<artifact-id>');
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const revision = cmd.options.integer('revision');
  if (revision !== undefined) {
    if (revision <= 0) throw new CliError('--revision expects a positive revision number', EXIT_USAGE);
    body.revisionNumber = revision;
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'artifacts.preview.start', {
    params: { artifactId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderPreview);
  cmd.out.note(
    'a `previewUrl` above is served by the node itself; without one, the node has ' +
      'no preview origin configured and the fields above are the whole preview session',
  );
  return EXIT_OK;
}

async function artifactExport(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('artifact export', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['revision', 'out']);
  const artifactId = requireArg(cmd, 0, '<artifact-id>');
  const out = cmd.options.value('out');

  // Refuse to clobber and refuse stdout-under-structured BEFORE the download, so
  // a caller never pays for a transfer that could not be written anyway.
  if (out !== undefined && out !== '-' && existsSync(out)) {
    throw new CliError(`${out} already exists`, EXIT_USAGE, { hint: 'choose another --out path' });
  }
  const toStdout = out === undefined || out === '-';
  if (toStdout && cmd.out.format !== 'human') {
    throw new CliError(
      `raw bytes cannot be written under --format ${cmd.out.format}; ` +
        'raw bytes and structured output are mutually exclusive',
      EXIT_USAGE,
      { hint: 'pass --out <path> to write the zip to a file' },
    );
  }

  const revisionNumber = await resolveRevision(cmd, artifactId);
  const result = await observedExport(cmd, artifactId, revisionNumber);

  if (toStdout) {
    cmd.out.bytes(result.bytes);
    return EXIT_OK;
  }
  try {
    writeFileSync(out, result.bytes);
  } catch (err) {
    throw new CliError(
      `cannot write ${out}: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USAGE,
    );
  }
  cmd.out.note(
    `wrote ${result.bytes.length} bytes to ${out}${result.contentType ? ` (${result.contentType})` : ''}`,
  );
  return EXIT_OK;
}

/**
 * `--revision` is optional; when omitted, the current revision is resolved with
 * one `entities.get`, because the export URL carries `:revisionNumber` as a
 * required segment and the wire has no "latest" alias.
 */
async function resolveRevision(cmd: CommandContext, artifactId: string): Promise<number> {
  const raw = cmd.options.integer('revision');
  if (raw !== undefined) {
    if (raw <= 0) throw new CliError('--revision expects a positive revision number', EXIT_USAGE);
    return raw;
  }
  const detail = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.get', {
    params: { id: artifactId },
  });
  const content = (detail as { content?: { kind?: unknown; currentRevisionNumber?: unknown } } | null)?.content;
  if (content?.kind === 'artifact' && Number.isInteger(content.currentRevisionNumber)) {
    return content.currentRevisionNumber as number;
  }
  throw new CliError('could not resolve the current revision', EXIT_USAGE, {
    hint: 'pass --revision <n> explicitly; `tm8 artifact revisions <artifact-id>` lists them',
  });
}

/**
 * The bytes path for `artifacts.export`, recording availability the same way
 * `file download` does: an honest 501 is decided before any handler runs, so
 * learning from it costs the caller nothing; every other outcome is re-thrown.
 */
async function observedExport(
  cmd: CommandContext,
  artifactId: string,
  revisionNumber: number,
): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
  const name: OperationName = 'artifacts.export';
  try {
    const res = await clientFor(cmd.ctx).download(name, {
      params: { artifactId, revisionNumber: String(revisionNumber) },
    });
    ledger.record(name, 'handled');
    return { bytes: res.bytes, contentType: res.contentType };
  } catch (err) {
    if (err instanceof ApiError) {
      ledger.record(name, err.code === 'not_implemented' ? 'not_implemented' : 'handled');
    }
    throw err;
  }
}

// ── mutations ────────────────────────────────────────────────────────────────

async function artifactRestore(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['revision', 'expect-version', 'mutation-id']);
  const artifactId = requireArg(cmd, 0, '<artifact-id>');
  const revisionNumber = cmd.options.integer('revision');
  if (revisionNumber === undefined || revisionNumber <= 0) {
    throw new CliError('tm8 artifact restore requires --revision <n> (the revision to restore)', EXIT_USAGE);
  }
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined || expectedVersion <= 0) {
    throw new CliError('tm8 artifact restore requires --expect-version <n>', EXIT_USAGE, {
      hint: 'read the current version with `tm8 entity get <artifact-id>`',
    });
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'artifacts.restore', {
    params: { artifactId },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      expectedVersion,
      revisionNumber,
    }),
  });
  cmd.out.data(data, renderArtifactMutation);
  return EXIT_OK;
}

// ── human renderings of the SAME DTO `--format json` emits ───────────────────

interface RevisionRow {
  revisionNumber?: unknown;
  manifestSha256?: unknown;
  entrypoint?: unknown;
  fileCount?: unknown;
  totalSizeBytes?: unknown;
  createdAt?: unknown;
}

function revisionRowsOf(dto: unknown): RevisionRow[] {
  if (Array.isArray(dto)) return dto as RevisionRow[];
  const items = (dto as { items?: unknown; revisions?: unknown } | null)?.items
    ?? (dto as { revisions?: unknown } | null)?.revisions;
  return Array.isArray(items) ? (items as RevisionRow[]) : [];
}

function renderRevisions(dto: unknown): string {
  const rows = revisionRowsOf(dto);
  if (rows.length === 0) return 'no revisions';
  return rows
    .map((r) =>
      `r${String(r.revisionNumber)}  ${String(r.entrypoint ?? '')}  ` +
      `${String(r.fileCount ?? '?')} files  ${String(r.totalSizeBytes ?? '?')}B  ` +
      `${String(r.manifestSha256 ?? '')}`.trimEnd(),
    )
    .join('\n');
}

/** A publish/create/restore result — the artifact summary and its new revision. */
function renderArtifactMutation(dto: unknown): string {
  const r = (dto ?? {}) as {
    entity?: { id?: unknown; kind?: unknown; title?: unknown; version?: unknown };
    artifact?: { id?: unknown; kind?: unknown; title?: unknown; version?: unknown };
    revision?: RevisionRow;
    revisionNumber?: unknown;
  };
  const entity = r.entity ?? r.artifact;
  const lines: string[] = [];
  if (entity && entity.id !== undefined) lines.push(summaryLine(entity));
  const revisionNumber = r.revision?.revisionNumber ?? r.revisionNumber;
  if (revisionNumber !== undefined) lines.push(`revision: r${String(revisionNumber)}`);
  return lines.length > 0 ? lines.join('\n') : JSON.stringify(dto);
}

/**
 * A preview session, exactly as the Server returned it — every field it named,
 * never a fabricated preview URL. A `previewUrl` is printed only if the Server
 * itself supplied one.
 */
function renderPreview(dto: unknown): string {
  const p = (dto ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const show = (label: string, ...keys: string[]): void => {
    for (const key of keys) {
      if (p[key] !== undefined && p[key] !== null) {
        lines.push(`${label}: ${String(p[key])}`);
        return;
      }
    }
  };
  show('sessionId', 'previewSessionId', 'sessionId', 'id');
  show('token', 'token');
  show('expiresAt', 'expiresAt', 'expiry');
  show('revisionNumber', 'revisionNumber', 'revision');
  show('previewUrl', 'previewUrl', 'url');
  return lines.length > 0 ? lines.join('\n') : JSON.stringify(dto);
}

/**
 * The array `commands/registry.ts` imports and spreads. `artifact publish`
 * appears ONCE even though it composes `artifacts.create` and
 * `artifacts.publish`.
 */
export const ARTIFACT_COMMANDS: CommandModule[] = [
  { path: ['artifact', 'publish'], run: artifactPublish },
  { path: ['artifact', 'revisions'], run: artifactRevisions },
  { path: ['artifact', 'preview'], run: artifactPreview },
  { path: ['artifact', 'export'], run: artifactExport },
  { path: ['artifact', 'restore'], run: artifactRestore },
];
