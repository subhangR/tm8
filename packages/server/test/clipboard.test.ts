/**
 * The clipboard image handoff, at its three layers:
 *
 *   1. SNIFF — the declared Content-Type is a hint and the bytes are the
 *      truth. This is the guard that stops the handoff directory from being a
 *      way to write arbitrary files onto the node, so it is asserted both
 *      ways: an unrecognized body is refused, and a body that disagrees with
 *      its declared type is refused even though both types are allowed.
 *   2. PLACEMENT — space bucket, date bucket, real extension, and a mode a
 *      separate agent process can actually read. The 0644/0755 is the whole
 *      reason this is not the blob store, so it is pinned.
 *   3. TRANSPORT — the route authorizes by VISIBILITY (RLS decides), and
 *      not-visible and nonexistent are the same 404.
 */
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ClipboardStore,
  clipboardDateBucket,
  sniffImageMimeType,
} from '../src/files/clipboard-store.js';
import { createClipboardUploadRoute, CLIPBOARD_UPLOAD_PATH } from '../src/http/clipboard-upload.js';
import type { RequestIdentity } from '../src/http/types.js';

const SPACE = '0192abcd-1111-7222-8333-444455556666';
const SESSION = '0192abcd-9999-7222-8333-444455556666';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from('GIF89a....', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
]);

const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tm8-clipboard-'));
}

describe('sniffImageMimeType', () => {
  it('identifies every accepted format by its leading bytes', () => {
    expect(sniffImageMimeType(PNG)).toBe('image/png');
    expect(sniffImageMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffImageMimeType(GIF)).toBe('image/gif');
    expect(sniffImageMimeType(WEBP)).toBe('image/webp');
  });

  it('refuses anything it cannot positively identify', () => {
    expect(sniffImageMimeType(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBeNull();
    // A RIFF container that is NOT a WEBP — the form type is what decides.
    expect(
      sniffImageMimeType(
        Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.from([0, 0, 0, 0]),
          Buffer.from('WAVE', 'latin1'),
        ]),
      ),
    ).toBeNull();
    expect(sniffImageMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('ClipboardStore.store', () => {
  it('places the image under space and date buckets with a real extension', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const result = await store.store({ data: PNG, spaceId: SPACE });

    expect(result.mimeType).toBe('image/png');
    expect(result.bytes).toBe(PNG.length);
    expect(result.filename.endsWith('.png')).toBe(true);
    expect(result.path).toContain(join('0192abcd', clipboardDateBucket()));
    await expect(readFile(result.path)).resolves.toEqual(PNG);
  });

  it('writes modes a separate agent process can read', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const { path } = await store.store({ data: JPEG, spaceId: SPACE });

    // 0644/0755, NOT the blob store's 0600/0700: the whole point of this
    // directory is that something other than the server opens the file.
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o755);
  });

  /**
   * THE WIDENING (R2) — the store took four image formats, so a terminal user
   * could paste a screenshot but not the PDF, the CSV or the log file they
   * were being asked about, while the chat composer beside them took all
   * four. The allowlist is the contract's `isAgentReadableMime` now, and
   * these pin both halves: what it accepts, and what it still refuses when
   * the bytes and the declaration disagree.
   */
  it('takes a PDF, identified by its own signature', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const result = await store.store({ data: PDF, spaceId: SPACE });
    expect(result.mimeType).toBe('application/pdf');
    expect(result.filename.endsWith('.pdf')).toBe(true);
  });

  it('takes text, which has no signature at all, on its declared type', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const result = await store.store({
      data: Buffer.from('id,name\n1,alex\n'),
      declaredMimeType: 'text/csv',
      spaceId: SPACE,
    });
    expect(result.mimeType).toBe('text/csv');
    expect(result.filename.endsWith('.csv')).toBe(true);
  });

  it('types an octet-stream by its FILENAME — every source file arrives that way', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const result = await store.store({
      data: Buffer.from('print("hi")\n'),
      declaredMimeType: 'application/octet-stream',
      declaredFilename: 'deploy.py',
      spaceId: SPACE,
    });
    expect(result.mimeType).toBe('text/plain');
    // The EXTENSION is kept — a human reading the path out of the terminal
    // can see what it is — while the base name is still generated here.
    expect(result.filename.endsWith('.py')).toBe(true);
    expect(result.filename).not.toContain('deploy');
  });

  it('refuses an archive: agents cannot read one', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    await expect(store.store({ data: ZIP, spaceId: SPACE })).rejects.toThrow(/archive/);
  });

  it('takes a .docx — the SAME signature, resolved by what it declares', async () => {
    // `.docx`, `.xlsx` and every OpenDocument file are ZIP containers, so the
    // signature alone cannot separate a readable document from an archive.
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const result = await store.store({
      data: ZIP,
      declaredMimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      spaceId: SPACE,
    });
    expect(result.filename.endsWith('.docx')).toBe(true);
  });

  it('refuses an executable whatever it claims to be', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    await expect(
      store.store({ data: ELF, declaredMimeType: 'text/plain', spaceId: SPACE }),
    ).rejects.toThrow(/executable/);
  });

  it('refuses an archive wearing a text declaration', async () => {
    // The signature wins: written as `.txt` an agent would read it as prose.
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    await expect(
      store.store({ data: ZIP, declaredMimeType: 'text/plain', spaceId: SPACE }),
    ).rejects.toThrow(/does not match content/);
  });

  it('refuses a type outside the agent-readable set', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    await expect(
      store.store({ data: Buffer.from('x'), declaredMimeType: 'application/zip', spaceId: SPACE }),
    ).rejects.toThrow(/agents cannot read/);
  });

  it('refuses content nothing can type — no signature, no type, no name', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    await expect(
      store.store({ data: Buffer.from([0x01, 0x02, 0x03]), spaceId: SPACE }),
    ).rejects.toThrow(/could not be established/);
  });

  it('never lets a filename reach the path it writes', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const result = await store.store({
      data: PNG,
      declaredFilename: '../../etc/passwd',
      spaceId: SPACE,
    });
    // The name is a candidate EXTENSION and nothing else, and this one has
    // none that survives `[a-z0-9]{1,8}`.
    expect(result.filename.endsWith('.png')).toBe(true);
    expect(result.path).not.toContain('..');
  });

  it('refuses a declared type that disagrees with the bytes', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    await expect(
      store.store({ data: PNG, declaredMimeType: 'image/gif', spaceId: SPACE }),
    ).rejects.toThrow(/does not match content/);
  });

  it('accepts image/jpg as an alias rather than reading it as a mismatch', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const result = await store.store({
      data: JPEG,
      declaredMimeType: 'image/jpg; charset=binary',
      spaceId: SPACE,
    });
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('refuses an image over the configured ceiling', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch(), maxBytes: 4 });
    await expect(store.store({ data: PNG, spaceId: SPACE })).rejects.toThrow(/maximum size/);
  });

  it('refuses a spaceId that is not a uuid, so no bucket can be forged', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    await expect(store.store({ data: PNG, spaceId: '../../etc' })).rejects.toThrow(/uuid/);
  });
});

describe('ClipboardStore.sweepExpired', () => {
  it('removes date buckets past the retention window and keeps the rest', async () => {
    const dir = await scratch();
    const store = new ClipboardStore({ clipboardDir: dir, retentionDays: 30 });
    const spaceDir = join(dir, '0192abcd');
    await mkdir(join(spaceDir, '2020-01-01'), { recursive: true });
    await mkdir(join(spaceDir, '2999-01-01'), { recursive: true });
    // Not a date bucket at all: left alone rather than guessed about.
    await mkdir(join(spaceDir, 'notes'), { recursive: true });
    await writeFile(join(spaceDir, '2020-01-01', 'old.png'), PNG);

    expect(await store.sweepExpired()).toBe(1);
    expect((await readdir(spaceDir)).sort()).toEqual(['2999-01-01', 'notes']);
  });

  it('keeps everything when retention is disabled', async () => {
    const dir = await scratch();
    const store = new ClipboardStore({ clipboardDir: dir, retentionDays: 0 });
    await mkdir(join(dir, '0192abcd', '2020-01-01'), { recursive: true });
    expect(await store.sweepExpired()).toBe(0);
  });
});

/** A minimal request/response pair — the route only reads a few fields. */
function fakeRequest(body: Buffer, url: string, contentType?: string) {
  return {
    method: 'POST',
    url,
    headers: contentType ? { 'content-type': contentType } : {},
    resume() {},
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  } as never;
}

function fakeResponse() {
  const captured = { status: 0, body: '' };
  return {
    captured,
    res: {
      writeHead(status: number) {
        captured.status = status;
        return this;
      },
      end(chunk?: string) {
        captured.body = chunk ?? '';
      },
      setHeader() {},
      headersSent: false,
    } as never,
  };
}

function routeWith(rows: Array<{ space_id: string }>, store: ClipboardStore) {
  return createClipboardUploadRoute({
    deps: {
      db: { query: async () => rows } as never,
      config: {} as never,
      owner: async () => ({ identityId: 'owner-1', isNodeAdmin: true }) as never,
    } as never,
    store,
  });
}

const IDENTITY: RequestIdentity = {
  kind: 'bearer',
  identityId: 'identity-1',
  nodeAdmin: false,
} as RequestIdentity;

describe('POST /v2/clipboard/images', () => {
  it('answers a non-matching request with false so the pipeline continues', async () => {
    const route = routeWith([{ space_id: SPACE }], new ClipboardStore({ clipboardDir: await scratch() }));
    const { res } = fakeResponse();
    const handled = await route(
      fakeRequest(PNG, '/v2/entities'),
      res,
      { requestId: 'req-1', identity: IDENTITY },
    );
    expect(handled).toBe(false);
  });

  it('stores the image and answers 201 with the node-local path', async () => {
    const store = new ClipboardStore({ clipboardDir: await scratch() });
    const route = routeWith([{ space_id: SPACE }], store);
    const { res, captured } = fakeResponse();

    const handled = await route(
      fakeRequest(PNG, `${CLIPBOARD_UPLOAD_PATH}?sessionId=${SESSION}`, 'image/png'),
      res,
      { requestId: 'req-2', identity: IDENTITY },
    );

    expect(handled).toBe(true);
    expect(captured.status).toBe(201);
    const payload = JSON.parse(captured.body) as { path: string; mimeType: string };
    expect(payload.mimeType).toBe('image/png');
    await expect(readFile(payload.path)).resolves.toEqual(PNG);
  });

  it('is a 404 when the session is not visible — same answer as nonexistent', async () => {
    // No rows is what RLS returns for BOTH cases; the route must not be able
    // to tell them apart, and neither must the caller.
    const route = routeWith([], new ClipboardStore({ clipboardDir: await scratch() }));
    const { res, captured } = fakeResponse();

    await route(
      fakeRequest(PNG, `${CLIPBOARD_UPLOAD_PATH}?sessionId=${SESSION}`, 'image/png'),
      res,
      { requestId: 'req-3', identity: IDENTITY },
    );
    expect(captured.status).toBe(404);
  });

  it('is a 404 for a sessionId that is not even uuid-shaped', async () => {
    const route = routeWith([{ space_id: SPACE }], new ClipboardStore({ clipboardDir: await scratch() }));
    const { res, captured } = fakeResponse();

    await route(
      fakeRequest(PNG, `${CLIPBOARD_UPLOAD_PATH}?sessionId=../../etc/passwd`),
      res,
      { requestId: 'req-4', identity: IDENTITY },
    );
    expect(captured.status).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const route = routeWith([{ space_id: SPACE }], new ClipboardStore({ clipboardDir: await scratch() }));
    const { res, captured } = fakeResponse();

    await route(
      fakeRequest(PNG, `${CLIPBOARD_UPLOAD_PATH}?sessionId=${SESSION}`, 'image/png'),
      res,
      { requestId: 'req-5', identity: { kind: 'anonymous' } as RequestIdentity },
    );
    expect(captured.status).toBe(401);
  });
});
