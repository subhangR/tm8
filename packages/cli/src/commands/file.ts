/**
 * `tm8 file …` — the blob lifecycle (§4.10).
 *
 * THREE COMMANDS OVER FOUR CATALOG OPERATIONS, AND THE CARDINALITY IS THE
 * POINT. `file upload` is a COMPOSED command: one caller-visible invocation
 * that performs `files.uploadInit`, then the grant transfer, then
 * `files.uploadComplete`, and calls `files.uploadAbort` itself when a stage
 * fails after the slot was reserved. It is registered ONCE — the registry
 * throws at import on a duplicate path, so registering the two upload rows
 * separately would not fail a test, it would collapse the whole package's
 * suite.
 *
 * ONE MUTATION ID MAY NEVER BE REUSED ACROSS STAGES (§4.10, §7.4). The caller
 * supplies (or the CLI generates) ONE ROOT id; each catalog mutation receives
 * its own id derived from that root by `deriveMutationId(root, stage)`. This is
 * not tidiness. The Server's idempotency ledger is keyed by
 * `(clientMutationId, operation)` and replays a stored result for a repeat: a
 * composition that sent one id to both stages would hand `uploadComplete` the
 * ledger row `uploadInit` wrote. Deriving is deterministic, so a retried
 * composition re-derives the SAME stage ids and each stage replays correctly
 * against its own row.
 *
 * `file upload abort` used on its own is a SINGLE-operation command, so it uses
 * the caller's id directly. Deriving there would mean an operator's `--yes
 * --mutation-id X` abort and the composition's automatic abort could never be
 * the same mutation, which is exactly backwards.
 *
 * THE GRANT PUT IS THE ONE NON-CATALOG TRANSPORT. `files.uploadInit` answers a
 * `FileUploadGrant` whose `uploadUrl` is a raw byte sink mounted OUTSIDE the
 * semantic router — it is transport for a grant, not an operation, and it is
 * the only request in this package that does not come from `bindPath`. Its URL
 * is read from the grant the Server just issued; nothing here composes one.
 *
 * `files.download` answers RAW BYTES, outside the `{data, requestId}` envelope
 * — the documented exception. Bytes and structured output are mutually
 * exclusive on stdout (§7.3), so `--output <path>` writes the blob to that path
 * and leaves stdout EMPTY rather than inventing a CLI-private summary DTO to
 * put there.
 *
 * `bridge.fetchBlob` gets NOTHING here. It is permanently reserved, internal,
 * Server-to-Server, and stays discoverable by exact lookup while never
 * rendering invocation syntax. The caller-facing way to read bytes is
 * `file download`.
 *
 * WHOLE-BLOB BUFFERING, STATED PLAINLY. This composition reads the source into
 * memory to compute its size and checksum and then PUTs it. Chunked/resumable
 * transfer is `file upload resume`, which §4.10 marks PROPOSED with no frozen
 * catalog row — so it is not built here, and this file does not pretend to
 * stream.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SHA256_HEX_RE, WireErrorBodySchema, type OperationName } from '@tm8/contract';
import { requireSpace } from '../context.js';
import { ApiError, ProtocolError, TransportError } from '../errors.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { deriveMutationId, refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { ledger } from '../discovery/availability.js';
import type { CommandContext, CommandModule } from '../run.js';

/** The contract's own default when a caller declares no media type. */
const DEFAULT_MIME = 'application/octet-stream';

/** `uniqueArray(EntityIdSchema, 0, 16)` — the frozen completion-target bound. */
const MAX_ATTACH_TARGETS = 16;

interface FileUploadGrant {
  uploadId: string;
  uploadUrl: string;
  token?: string | null;
  expiresAt: string;
  maxSizeBytes: number;
}

function requireArg(raw: string | undefined, command: string, placeholder: string): string {
  if (raw === undefined || raw === '') {
    throw new CliError(`tm8 ${command} requires ${placeholder}`, EXIT_USAGE, {
      hint: `read its contract with \`tm8 help ${command}\``,
    });
  }
  return raw;
}

function requireConfirmation(cmd: CommandContext, command: string, what: string): void {
  if (!cmd.options.bool('yes')) {
    throw new CliError(`tm8 ${command} ${what}; pass --yes to confirm`, EXIT_USAGE);
  }
}

/** `<path|->`: the blob's BYTES, never decoded as text. */
async function readBlob(source: string): Promise<Buffer> {
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  try {
    return readFileSync(source);
  } catch (err) {
    throw new CliError(
      `cannot read ${source}: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USAGE,
    );
  }
}

/**
 * A declared `--size`/`--sha256` is CHECKED against the bytes rather than
 * trusted. The Server verifies both at completion anyway, so a disagreement is
 * a wasted upload of the whole blob followed by a refusal; and a caller who
 * declared a checksum that does not match what they are sending has a bug
 * upstream that this is the cheapest place to surface.
 */
function reconcileDeclaration(
  cmd: CommandContext,
  bytes: Buffer,
): { sizeBytes: number; checksumSha256: string } {
  const sizeBytes = bytes.length;
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');

  const declaredSize = cmd.options.integer('size');
  if (declaredSize !== undefined && declaredSize !== sizeBytes) {
    throw new CliError(
      `--size ${declaredSize} disagrees with the source, which is ${sizeBytes} bytes`,
      EXIT_USAGE,
    );
  }
  const declaredSha = cmd.options.value('sha256');
  if (declaredSha !== undefined) {
    if (!SHA256_HEX_RE.test(declaredSha)) {
      throw new CliError(
        `--sha256 expects a lowercase 64-character hex digest, got ${JSON.stringify(declaredSha)}`,
        EXIT_USAGE,
      );
    }
    if (declaredSha !== checksumSha256) {
      throw new CliError(
        `--sha256 disagrees with the source, whose sha-256 is ${checksumSha256}`,
        EXIT_USAGE,
      );
    }
  }
  if (sizeBytes === 0) {
    throw new CliError('the source is empty; a file upload carries at least one byte', EXIT_USAGE);
  }
  return { sizeBytes, checksumSha256 };
}

function attachTargets(cmd: CommandContext): string[] {
  const targets = cmd.options.values('attach-to');
  if (targets.length > MAX_ATTACH_TARGETS) {
    throw new CliError(
      `--attach-to accepts at most ${MAX_ATTACH_TARGETS} entity ids, got ${targets.length}`,
      EXIT_USAGE,
    );
  }
  if (new Set(targets).size !== targets.length) {
    throw new CliError('--attach-to values must be unique', EXIT_USAGE);
  }
  return targets;
}

/**
 * The grant transfer. Not a catalog operation and deliberately not routed
 * through `Tm8Client`, whose entire contract is "every path comes from
 * bindPath". The URL comes from the grant the Server just issued; a failure is
 * still a DEV-8 body and is mapped to the same typed taxonomy as any other
 * refusal, so a 413 here exits 9 exactly as a 413 from `uploadInit` would.
 */
async function transferBytes(
  cmd: CommandContext,
  grant: FileUploadGrant,
  bytes: Buffer,
): Promise<void> {
  const url = new URL(grant.uploadUrl, cmd.ctx.baseUrl.value);
  const headers: Record<string, string> = { 'content-type': DEFAULT_MIME };
  if (grant.token) headers.authorization = `Bearer ${grant.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cmd.ctx.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(bytes),
      signal: controller.signal,
    });
  } catch (err) {
    throw new TransportError(
      `PUT ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status < 400) return;
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    parsed = undefined;
  }
  const wire = WireErrorBodySchema.safeParse(parsed);
  if (wire.success) {
    const { code, message, requestId, retryable, details } = wire.data.error;
    throw new ApiError(res.status, code, message, requestId, retryable, details, 'files.uploadInit');
  }
  throw new ProtocolError(
    `the upload grant transfer answered ${res.status} with a body that is not a contract error (DEV-8): ${
      text ? text.slice(0, 200) : '<empty>'
    }`,
    res.status,
    parsed ?? text,
  );
}

/**
 * Recovery, not cleanup theatre: the slot is reserved on the Server and holds
 * disk until it expires, so a failed composition releases it. The abort's own
 * failure is REPORTED and never replaces the original diagnostic — the caller
 * needs to know why the upload failed first, and that the slot may linger
 * second.
 */
async function abortAfterFailure(cmd: CommandContext, uploadId: string, abortId: string): Promise<void> {
  try {
    await observedInvoke<unknown>(clientFor(cmd.ctx), 'files.uploadAbort', {
      params: { uploadId },
      body: { clientMutationId: abortId },
    });
    cmd.out.warn(`upload ${uploadId} was aborted after the failure below`);
  } catch (err) {
    cmd.out.warn(
      `upload ${uploadId} could not be aborted (${
        err instanceof Error ? err.message : String(err)
      }); it expires with its grant`,
    );
  }
}

// ── the commands ───────────────────────────────────────────────────────────

async function fileUpload(cmd: CommandContext): Promise<ExitCode> {
  const source = requireArg(cmd.args[0], 'file upload', '<path|->');
  const spaceId = requireSpace(cmd.ctx);
  const targets = attachTargets(cmd);

  const bytes = await readBlob(source);
  const { sizeBytes, checksumSha256 } = reconcileDeclaration(cmd, bytes);

  const name = cmd.options.value('name') ?? (source === '-' ? undefined : basename(source));
  if (name === undefined || name.length === 0) {
    throw new CliError('tm8 file upload from stdin requires --name <name>', EXIT_USAGE, {
      hint: 'a blob read from `-` has no filename to take a name from',
    });
  }
  const mime = cmd.options.value('mime') ?? DEFAULT_MIME;

  // ONE caller-visible root, one derived id per catalog mutation. Never reused.
  const root = resolveMutationId(cmd.options.value('mutation-id'));
  const initId = deriveMutationId(root, 'files.uploadInit');
  const completeId = deriveMutationId(root, 'files.uploadComplete');
  const abortId = deriveMutationId(root, 'files.uploadAbort');

  const client = clientFor(cmd.ctx);
  const initBody: Record<string, unknown> = {
    spaceId,
    name,
    mime,
    sizeBytes,
    checksumSha256,
    clientMutationId: initId,
  };
  if (cmd.ctx.actor) initBody.actorId = cmd.ctx.actor.value;

  const grant = await observedInvoke<FileUploadGrant>(client, 'files.uploadInit', { body: initBody });

  try {
    await transferBytes(cmd, grant, bytes);
  } catch (err) {
    await abortAfterFailure(cmd, grant.uploadId, abortId);
    throw err;
  }

  const completeBody: Record<string, unknown> = { clientMutationId: completeId };
  if (targets.length > 0) completeBody.targets = targets;
  if (cmd.ctx.actor) completeBody.actorId = cmd.ctx.actor.value;

  let result: unknown;
  try {
    result = await observedInvoke<unknown>(client, 'files.uploadComplete', {
      params: { uploadId: grant.uploadId },
      body: completeBody,
    });
  } catch (err) {
    await abortAfterFailure(cmd, grant.uploadId, abortId);
    throw err;
  }

  cmd.out.data(result, renderUploaded);
  return EXIT_OK;
}

async function fileUploadAbort(cmd: CommandContext): Promise<ExitCode> {
  const uploadId = requireArg(cmd.args[0], 'file upload abort', '<upload-id>');
  requireConfirmation(cmd, 'file upload abort', 'discards the reserved slot and any transferred bytes');
  const body: Record<string, unknown> = {
    // A single-operation command: the caller's root IS this operation's id.
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'files.uploadAbort', {
    params: { uploadId },
    body,
  });
  cmd.out.data(data, () => `aborted upload ${uploadId}`);
  return EXIT_OK;
}

async function fileDownload(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('file download', cmd.options.value('mutation-id'));
  const fileEntityId = requireArg(cmd.args[0], 'file download', '<file-entity-id>');
  const output = cmd.options.require('output');
  const overwrite = cmd.options.bool('overwrite');

  // Checked BEFORE the request: refusing after downloading a blob wastes the
  // transfer and, worse, invites a caller to re-run with --overwrite having
  // already paid for it.
  if (output !== '-' && existsSync(output) && !overwrite) {
    throw new CliError(`${output} already exists`, EXIT_USAGE, {
      hint: 'pass --overwrite to replace it, or choose another --output path',
    });
  }
  // `--output -` under a structured format is refused here rather than after
  // the bytes arrive, for the same reason.
  if (output === '-' && cmd.out.format !== 'human') {
    throw new CliError(
      `raw bytes cannot be written under --format ${cmd.out.format}; ` +
        'raw bytes and structured output are mutually exclusive',
      EXIT_USAGE,
    );
  }

  const result = await observedDownload(cmd, 'files.download', fileEntityId);

  if (output === '-') {
    cmd.out.bytes(result.bytes);
    return EXIT_OK;
  }
  try {
    writeFileSync(output, result.bytes);
  } catch (err) {
    throw new CliError(
      `cannot write ${output}: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USAGE,
    );
  }
  // stdout stays EMPTY: the requested data went to the file, and a summary
  // object here would be a CLI-private envelope on the data stream.
  cmd.out.note(
    `wrote ${result.bytes.length} bytes to ${output}${
      result.contentType ? ` (${result.contentType})` : ''
    }`,
  );
  return EXIT_OK;
}

/**
 * `observedInvoke` for the BYTES path. Same NARROWED rule as observe.ts
 * (applied 2026-07-31, when live S2/S3 transport checks made pre-handler
 * `forbidden` real): an honest 501 records `not_implemented`; only codes a
 * handler alone can author (`version_conflict`, `invariant_violation`) record
 * `handled`; every ambiguous refusal teaches nothing. A transport failure
 * teaches nothing and records nothing.
 */
async function observedDownload(
  cmd: CommandContext,
  name: OperationName,
  fileEntityId: string,
): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
  try {
    const res = await clientFor(cmd.ctx).download(name, { params: { fileEntityId } });
    ledger.record(name, 'handled');
    return { bytes: res.bytes, contentType: res.contentType };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === 'not_implemented') ledger.record(name, 'not_implemented');
      else if (err.code === 'version_conflict' || err.code === 'invariant_violation') {
        ledger.record(name, 'handled');
      }
    }
    throw err;
  }
}

/** The composition's final result is the completion DTO — a contract DTO (§7). */
function renderUploaded(dto: unknown): string {
  const entity = (dto as { entity?: { id?: unknown; title?: unknown } } | null | undefined)?.entity;
  if (!entity || entity.id === undefined) return JSON.stringify(dto);
  return `fileEntityId: ${String(entity.id)}${entity.title === undefined ? '' : `  ${String(entity.title)}`}`;
}

/**
 * The array `commands/registry.ts` imports and spreads. `file upload` appears
 * ONCE even though it performs two durable operations.
 */
export const FILE_COMMANDS: CommandModule[] = [
  { path: ['file', 'upload'], run: fileUpload },
  { path: ['file', 'upload', 'abort'], run: fileUploadAbort },
  { path: ['file', 'download'], run: fileDownload },
];
