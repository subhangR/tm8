/**
 * `tm8 file …` — the blob lifecycle (§4.10), and the one row that deliberately
 * has NO command at all.
 *
 * THE CARDINALITY TRAP THIS FILE EXISTS TO PIN. `files.uploadInit` and
 * `files.uploadComplete` are TWO durable catalog operations behind ONE command
 * path, `file upload`. That is one CommandModule registered once — the registry
 * throws at IMPORT on a duplicate path, so a 1:1 generator that registered the
 * path twice would not fail one test, it would collapse every suite in the
 * package at once. Because one command spans two durable operations it is a
 * COMPOSED command, and §4.10 is explicit that each stage takes its OWN
 * deterministically derived mutation id: one id may never be reused across
 * stages. A naive composition reuses the caller's id for both, and the Server's
 * idempotency ledger would then answer the second stage with the FIRST stage's
 * stored result.
 *
 * `bridge.fetchBlob` is permanently reserved and has no command path. It stays
 * discoverable by exact lookup and must never render invocation syntax: a
 * reserved row that prints a command line is a promise the system cannot keep.
 *
 * `files.download` answers with RAW BYTES, outside the `{data, requestId}`
 * envelope — the documented exception. Bytes and structured output are mutually
 * exclusive on stdout (§7.3).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPath } from '@tm8/contract';
import { parseInvocation } from '../src/args.js';
import { responseMode } from '../src/client.js';
import { resolveContext } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { deriveMutationId, UUID_PATTERN } from '../src/mutation.js';
import { createOutput } from '../src/output.js';
import { FILE_COMMANDS } from '../src/commands/file.js';
import { commandDiscovery, discoveryFor, isCommandPath } from '../src/discovery/operations.js';

const SPACE = '00000000-0000-7000-8000-0000000000aa';
const UPLOAD = '00000000-0000-7000-8000-0000000000ee';
const FILE_ENTITY = '00000000-0000-7000-8000-0000000000ff';
const ANCHOR = '00000000-0000-7000-8000-000000000011';

interface Captured {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
  bytes: Buffer;
}

interface Answer {
  status?: number;
  body?: unknown;
  /** Raw bytes, for `files.download` and the grant PUT. */
  raw?: Buffer;
  contentType?: string;
}

let server: Server;
let baseUrl: string;
let requests: Captured[] = [];
let respond: (req: Captured) => Answer = () => ({ body: {} });
let scratch: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://tm8.invalid');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      let parsed: unknown;
      try {
        parsed = bytes.length === 0 ? undefined : (JSON.parse(bytes.toString('utf8')) as unknown);
      } catch {
        parsed = undefined;
      }
      const captured: Captured = {
        method: req.method ?? '',
        path: url.pathname,
        authorization: req.headers.authorization,
        body: parsed,
        bytes,
      };
      requests.push(captured);
      const answer = respond(captured);
      res.setHeader('x-tm8-request-id', 'req_test');
      res.statusCode = answer.status ?? 200;
      if (answer.raw !== undefined) {
        res.setHeader('content-type', answer.contentType ?? 'application/octet-stream');
        res.end(answer.raw);
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (res.statusCode === 204) {
        res.end();
        return;
      }
      res.end(
        res.statusCode >= 400
          ? JSON.stringify(answer.body)
          : JSON.stringify({ data: answer.body ?? {}, requestId: 'req_test' }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  requests = [];
  respond = () => ({ body: {} });
  scratch = mkdtempSync(join(tmpdir(), 'tm8-file-test-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Invocation {
  code: number;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
}

function moduleFor(positionals: readonly string[]) {
  return [...FILE_COMMANDS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((m) => m.path.every((seg, i) => positionals[i] === seg));
}

async function invoke(argv: readonly string[], session: Record<string, string> = {}): Promise<Invocation> {
  const parsed = parseInvocation(argv);
  const mod = moduleFor(parsed.positionals);
  if (!mod) throw new Error(`no file module for ${parsed.positionals.join(' ')}`);
  const stdout: Buffer[] = [];
  const stderr: string[] = [];
  const out = createOutput({
    format: parsed.globals.format,
    quiet: parsed.globals.quiet,
    streams: {
      stdout: (c) => void stdout.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c)),
      stderr: (c) => void stderr.push(c),
    },
  });
  const ctx = resolveContext({
    globals: parsed.globals,
    session: { baseUrl, spaceId: SPACE, ...session },
    config: {},
  });
  let code: number;
  try {
    code = await mod.run({
      path: mod.path,
      args: parsed.positionals.slice(mod.path.length),
      options: parsed.options,
      passthrough: parsed.passthrough,
      ctx,
      out,
    });
  } catch (err) {
    out.error(errorLines(err));
    code = exitCodeFor(err);
  }
  const bytes = Buffer.concat(stdout);
  return { code, stdout: bytes.toString('utf8'), stdoutBytes: bytes, stderr: stderr.join('') };
}

/** The three-stage happy path, with the grant the real Server actually returns. */
function grantingServer(uploadId = UPLOAD): void {
  respond = (req) => {
    if (req.path === bindPath('files.uploadInit')) {
      return {
        body: {
          uploadId,
          uploadUrl: `/v2/files/uploads/${uploadId}/content`,
          token: 'grant-token',
          expiresAt: '2026-07-27T01:00:00.000Z',
          maxSizeBytes: 536870912,
        },
      };
    }
    if (req.method === 'PUT') return { status: 204 };
    return { body: { entity: { id: FILE_ENTITY, kind: 'file', title: 'blob.bin' }, patches: [] } };
  };
}

describe('the file module and the cardinality of `file upload`', () => {
  it('claims exactly three paths — upload, upload abort, download', () => {
    expect(FILE_COMMANDS.map((c) => c.path.join(' ')).sort()).toEqual([
      'file download',
      'file upload',
      'file upload abort',
    ]);
  });

  it('registers `file upload` ONCE although it spans TWO catalog operations', () => {
    const uploads = FILE_COMMANDS.filter((c) => c.path.join(' ') === 'file upload');
    expect(uploads).toHaveLength(1);
    expect(commandDiscovery(['file', 'upload'])?.operations).toEqual([
      'files.uploadInit',
      'files.uploadComplete',
    ]);
  });

  it('every claimed path is in the frozen discovery projection', () => {
    for (const c of FILE_COMMANDS) {
      expect(isCommandPath(c.path), c.path.join(' ')).toBe(true);
    }
  });
});

describe('tm8 file upload — one command, two durable operations, two mutation ids', () => {
  it('runs init → grant PUT → complete, in that order, on catalog-bound paths', async () => {
    grantingServer();
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, Buffer.from('hello tm8'));
    const r = await invoke(['file', 'upload', path]);
    expect(r.code).toBe(0);
    expect(requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      `POST ${bindPath('files.uploadInit')}`,
      `PUT /v2/files/uploads/${UPLOAD}/content`,
      `POST ${bindPath('files.uploadComplete', { uploadId: UPLOAD })}`,
    ]);
  });

  it('derives a DISTINCT mutation id per stage, and never reuses the root', async () => {
    grantingServer();
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, Buffer.from('hello tm8'));
    const root = '018f0000-0000-7000-8000-000000000001';
    const r = await invoke(['file', 'upload', path, '--mutation-id', root]);
    expect(r.code).toBe(0);
    const init = (requests[0]?.body as Record<string, unknown>).clientMutationId;
    const complete = (requests[2]?.body as Record<string, unknown>).clientMutationId;
    expect(init).toBe(deriveMutationId(root, 'files.uploadInit'));
    expect(complete).toBe(deriveMutationId(root, 'files.uploadComplete'));
    expect(init).not.toBe(complete);
    expect(init).not.toBe(root);
    expect(complete).not.toBe(root);
  });

  it('generates a UUIDv7 root when none is supplied, and still derives both stages from it', async () => {
    grantingServer();
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, Buffer.from('x'));
    await invoke(['file', 'upload', path]);
    const init = String((requests[0]?.body as Record<string, unknown>).clientMutationId);
    const complete = String((requests[2]?.body as Record<string, unknown>).clientMutationId);
    expect(init).toMatch(UUID_PATTERN);
    expect(complete).toMatch(UUID_PATTERN);
    expect(init).not.toBe(complete);
  });

  it('declares the size and checksum it actually computed from the bytes', async () => {
    grantingServer();
    const path = join(scratch, 'blob.bin');
    const payload = Buffer.from('hello tm8');
    writeFileSync(path, payload);
    await invoke(['file', 'upload', path, '--name', 'named.bin', '--mime', 'text/plain']);
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body.spaceId).toBe(SPACE);
    expect(body.name).toBe('named.bin');
    expect(body.mime).toBe('text/plain');
    expect(body.sizeBytes).toBe(payload.length);
    expect(body.checksumSha256).toBe(createHash('sha256').update(payload).digest('hex'));
  });

  it('PUTs the exact bytes to the grant URL under the grant token — the one non-catalog transport', async () => {
    grantingServer();
    const path = join(scratch, 'blob.bin');
    const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f]);
    writeFileSync(path, payload);
    await invoke(['file', 'upload', path]);
    const put = requests[1];
    expect(put?.method).toBe('PUT');
    expect(put?.authorization).toBe('Bearer grant-token');
    expect(Buffer.compare(put?.bytes ?? Buffer.alloc(0), payload)).toBe(0);
  });

  it('sends --attach-to as the completion targets, on the FINAL stage', async () => {
    grantingServer();
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, Buffer.from('x'));
    await invoke(['file', 'upload', path, '--attach-to', ANCHOR]);
    expect((requests[2]?.body as Record<string, unknown>).targets).toEqual([ANCHOR]);
    // The init "legacy anchor" is deliberately unused: one flag, one meaning.
    expect('entityId' in (requests[0]?.body as Record<string, unknown>)).toBe(false);
  });

  it('refuses duplicate or over-cap --attach-to locally (uniqueArray(EntityId, 0, 16))', async () => {
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, Buffer.from('x'));
    const dupe = await invoke(['file', 'upload', path, '--attach-to', ANCHOR, '--attach-to', ANCHOR]);
    expect(dupe.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('aborts with its OWN derived id when the transfer fails, and rethrows the original refusal', async () => {
    const root = '018f0000-0000-7000-8000-000000000002';
    respond = (req) => {
      if (req.path === bindPath('files.uploadInit')) {
        return {
          body: {
            uploadId: UPLOAD,
            uploadUrl: `/v2/files/uploads/${UPLOAD}/content`,
            token: 'grant-token',
            expiresAt: '2026-07-27T01:00:00.000Z',
            maxSizeBytes: 536870912,
          },
        };
      }
      if (req.method === 'PUT') {
        return {
          status: 413,
          body: {
            error: {
              code: 'payload_too_large',
              message: 'too big',
              requestId: 'req_test',
              retryable: false,
            },
          },
        };
      }
      return { body: { patches: [] } };
    };
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, Buffer.from('hello'));
    const r = await invoke(['file', 'upload', path, '--mutation-id', root]);
    expect(r.code).toBe(9);
    const abort = requests.find((q) => q.path === bindPath('files.uploadAbort', { uploadId: UPLOAD }));
    expect(abort).toBeDefined();
    expect((abort?.body as Record<string, unknown>).clientMutationId).toBe(
      deriveMutationId(root, 'files.uploadAbort'),
    );
  });

  it('refuses a --size or --sha256 that disagrees with the bytes, before any network call', async () => {
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, Buffer.from('hello tm8'));
    const size = await invoke(['file', 'upload', path, '--size', '4']);
    expect(size.code).toBe(2);
    expect(requests).toEqual([]);
    const sha = await invoke([
      'file', 'upload', path, '--sha256', 'a'.repeat(64),
    ]);
    expect(sha.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('accepts a --size and --sha256 that AGREE with the bytes', async () => {
    grantingServer();
    const payload = Buffer.from('hello tm8');
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, payload);
    const r = await invoke([
      'file', 'upload', path,
      '--size', String(payload.length),
      '--sha256', createHash('sha256').update(payload).digest('hex'),
    ]);
    expect(r.code).toBe(0);
  });

  it('requires a Space in context', async () => {
    const path = join(scratch, 'blob.bin');
    writeFileSync(path, Buffer.from('x'));
    const parsed = parseInvocation(['file', 'upload', path]);
    const mod = moduleFor(parsed.positionals);
    const out = createOutput({ format: 'human', streams: { stdout: () => {}, stderr: () => {} } });
    const ctx = resolveContext({ globals: parsed.globals, session: { baseUrl }, config: {} });
    let code = 0;
    try {
      code = await mod!.run({
        path: mod!.path,
        args: parsed.positionals.slice(mod!.path.length),
        options: parsed.options,
        passthrough: parsed.passthrough,
        ctx,
        out,
      });
    } catch (err) {
      code = exitCodeFor(err);
    }
    expect(code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('an unreadable path is local validation, not a transport failure', async () => {
    const r = await invoke(['file', 'upload', join(scratch, 'absent.bin')]);
    expect(r.code).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe('tm8 file upload abort — a single-operation command', () => {
  it('§7.5: requires --yes', async () => {
    const r = await invoke(['file', 'upload', 'abort', UPLOAD]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(requests).toEqual([]);
  });

  it('uses the caller root id DIRECTLY — deriving is for the composed command only', async () => {
    respond = () => ({ body: { patches: [] } });
    const root = '018f0000-0000-7000-8000-000000000003';
    const r = await invoke(['file', 'upload', 'abort', UPLOAD, '--yes', '--mutation-id', root]);
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe(bindPath('files.uploadAbort', { uploadId: UPLOAD }));
    expect((requests[0]?.body as Record<string, unknown>).clientMutationId).toBe(root);
  });
});

describe('tm8 file download — the documented raw-bytes exception', () => {
  it('files.download is a BYTES row, never run through the envelope extractor', () => {
    expect(responseMode('files.download')).toBe('bytes');
    expect(responseMode('bridge.fetchBlob')).toBe('bytes');
  });

  it('writes the exact bytes to stdout for `--output -`', async () => {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    respond = () => ({ raw: payload, contentType: 'image/png' });
    const r = await invoke(['file', 'download', FILE_ENTITY, '--output', '-']);
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe(bindPath('files.download', { fileEntityId: FILE_ENTITY }));
    expect(Buffer.compare(r.stdoutBytes, payload)).toBe(0);
  });

  it('§7.3: raw bytes and structured output are mutually exclusive', async () => {
    respond = () => ({ raw: Buffer.from('x'), contentType: 'text/plain' });
    const r = await invoke(['file', 'download', FILE_ENTITY, '--output', '-', '--format', 'json']);
    expect(r.code).toBe(2);
    expect(r.stdoutBytes).toHaveLength(0);
  });

  it('writes to a path, leaves stdout empty, and reports on stderr', async () => {
    const payload = Buffer.from('downloaded');
    respond = () => ({ raw: payload, contentType: 'text/plain' });
    const target = join(scratch, 'out.bin');
    const r = await invoke(['file', 'download', FILE_ENTITY, '--output', target]);
    expect(r.code).toBe(0);
    expect(Buffer.compare(readFileSync(target), payload)).toBe(0);
    expect(r.stdoutBytes).toHaveLength(0);
    expect(r.stderr).toContain(target);
  });

  it('refuses to clobber an existing file without --overwrite', async () => {
    const target = join(scratch, 'out.bin');
    writeFileSync(target, Buffer.from('original'));
    respond = () => ({ raw: Buffer.from('replacement'), contentType: 'text/plain' });
    const blocked = await invoke(['file', 'download', FILE_ENTITY, '--output', target]);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('--overwrite');
    expect(readFileSync(target).toString()).toBe('original');
    expect(requests).toEqual([]);

    const forced = await invoke(['file', 'download', FILE_ENTITY, '--output', target, '--overwrite']);
    expect(forced.code).toBe(0);
    expect(readFileSync(target).toString()).toBe('replacement');
  });

  it('requires --output and refuses --mutation-id', async () => {
    const missing = await invoke(['file', 'download', FILE_ENTITY]);
    expect(missing.code).toBe(2);
    const mutation = await invoke(['file', 'download', FILE_ENTITY, '--output', '-', '--mutation-id', 'x']);
    expect(mutation.code).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe('bridge.fetchBlob — permanently reserved, and deliberately commandless', () => {
  it('this module registers nothing for it', () => {
    expect(FILE_COMMANDS.some((c) => c.path.includes('bridge'))).toBe(false);
  });

  it('has no command path and renders NO invocation syntax, while staying discoverable', () => {
    const row = discoveryFor('bridge.fetchBlob');
    expect(row.command).toBeNull();
    expect(row.syntax).toBeNull();
    expect(row.exposure).toBe('reserved');
    // Still answerable by exact lookup — reserved is not hidden.
    expect(row.summary.length).toBeGreaterThan(0);
    expect(row.publicComposite).toBe('files.download');
  });

  it('POSITIVE CONTROL: the same lookup DOES report a command for a row that has one', () => {
    // A negative assertion is worth nothing until the probe is shown able to
    // detect the positive. `discoveryFor` answers `null` for the reserved row
    // above only because it genuinely has no command — not because this lookup
    // returns null for everything.
    const download = discoveryFor('files.download');
    expect(download.command).toEqual(['file', 'download']);
    expect(download.syntax).toContain('tm8 file download');
    expect(download.exposure).not.toBe('reserved');
  });

  it('the caller-facing way to read bytes is `file download`, which IS registered', () => {
    expect(FILE_COMMANDS.some((c) => c.path.join(' ') === 'file download')).toBe(true);
    expect(commandDiscovery(['bridge', 'fetch-blob'])).toBeUndefined();
  });
});
