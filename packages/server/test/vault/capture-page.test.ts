/**
 * The server half of the vault capture page (src/vault/capture-page.ts; task
 * 01a1fa87-dd1a, WS-A): the prefix it claims even with the vault off, the only
 * files it serves with the vault on, and the parity of its headers with the
 * page's own copy (packages/vault/capture-page/src/headers.ts, as built).
 * relay.pg.test.ts serves the real page from a real node.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CAPTURE_RESPONSE_HEADERS, VaultCapturePageError, createVaultCapturePage, vaultCapturePageDir, type VaultCapturePage,
} from '../../src/vault/capture-page.js';
import { fakeResponse } from './fake-response.js';

let root: string;

function get(page: VaultCapturePage, path: string, method = 'GET') {
  const { res, sent } = fakeResponse();
  page.serve(method, path, res, 'req-capture');
  return { status: sent.status, headers: sent.headers, body: sent.body?.toString('utf8') ?? null };
}

/** A page directory: index.html, capture.css and dist/ with the given modules. */
async function pageDir(name: string, modules: Record<string, string> | null, omit: readonly string[] = []): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir);
  if (!omit.includes('index.html')) await writeFile(join(dir, 'index.html'), '<!doctype html><title>capture</title>');
  if (!omit.includes('capture.css')) await writeFile(join(dir, 'capture.css'), 'body{margin:0}');
  if (modules) {
    await mkdir(join(dir, 'dist'));
    for (const [file, body] of Object.entries(modules)) await writeFile(join(dir, 'dist', file), body);
  }
  return dir;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm8-vault-capture-'));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('vault capture page', () => {
  it('claims /vault/capture and everything under it, so the SPA fallback never sees a capture link', () => {
    const page = createVaultCapturePage({ enabled: false });
    expect(['/vault/capture', '/vault/capture/', '/vault/capture/import', '/vault/capture/assets/capture.js'].map((path) => page.matches(path)))
      .toEqual([true, true, true, true]);
    expect(['/vault/captured', '/vault/capturex/a', '/vault', '/v2/vault/capture', '/x/vault/capture'].map((path) => page.matches(path)))
      .toEqual([false, false, false, false, false]);
  });

  it('with the vault off answers 404 under the page headers, reads no file, and allows only GET and HEAD', () => {
    const page = createVaultCapturePage({ enabled: false, dir: join(root, 'never-read') });
    const off = get(page, '/vault/capture/0b3c2f0e-3d7c-4a4e-9a51-1f7a1c1c1c1c');
    expect([off.status, off.body]).toEqual([404, 'the vault is off on this node\n']);
    expect(off.headers).toMatchObject({ ...CAPTURE_RESPONSE_HEADERS, 'x-tm8-request-id': 'req-capture' });
    expect(get(page, '/vault/capture/import', 'HEAD')).toMatchObject({ status: 404, body: null });
    const post = get(page, '/vault/capture/import', 'POST');
    expect([post.status, post.headers['allow']]).toEqual([405, 'GET, HEAD']);
    expect(post.headers['Content-Security-Policy']).toBe(CAPTURE_RESPONSE_HEADERS['Content-Security-Policy']);
  });

  it('serves the document for every page path, and as assets only capture.css and the import closure of capture.js', async () => {
    const dir = await pageDir('closure', {
      'capture.js': "import { a } from './a.js';\nimport './side.js';\nvoid import('./lazy.js');\nconsole.log(a);\n",
      'a.js': "export * from './b.js';\nexport const a = 1;\n",
      'b.js': 'export const b = 2;\n',
      'side.js': 'globalThis.side = 1;\n',
      'lazy.js': 'export const lazy = 3;\n',
      // Left by an incremental build after its source was deleted: never served.
      'stale.js': 'export const stale = 4;\n',
      'capture.d.ts': 'export {};\n',
    });
    const page = createVaultCapturePage({ enabled: true, dir });
    for (const path of ['/vault/capture', '/vault/capture/import', '/vault/capture/0b3c2f0e-3d7c-4a4e-9a51-1f7a1c1c1c1c', '/vault/capture/anything/else']) {
      const doc = get(page, path);
      expect([path, doc.status, doc.headers['content-type'], doc.body]).toEqual([path, 200, 'text/html; charset=utf-8', '<!doctype html><title>capture</title>']);
      expect(doc.headers).toMatchObject(CAPTURE_RESPONSE_HEADERS);
    }
    const served = (name: string): number => get(page, `/vault/capture/assets/${name}`).status;
    expect(['capture.js', 'a.js', 'b.js', 'side.js', 'lazy.js', 'capture.css'].map(served)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(['stale.js', 'capture.d.ts', 'index.html', '', 'dist/a.js', '../index.html'].map(served)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(get(page, '/vault/capture/assets/a.js').headers['content-type']).toBe('text/javascript; charset=utf-8');
    const head = get(page, '/vault/capture/assets/capture.css', 'HEAD');
    expect([head.status, head.body, head.headers['content-length']]).toEqual([200, null, String('body{margin:0}'.length)]);
  });

  it('refuses to start with the vault on and the page incomplete', async () => {
    const cases: Array<[string, Promise<string>]> = [
      ['no dist', pageDir('no-dist', null)],
      ['no capture.js', pageDir('no-entry', { 'a.js': '' })],
      ['a missing import', pageDir('missing-import', { 'capture.js': "import './gone.js';\n" })],
      ['no index.html', pageDir('no-index', { 'capture.js': '' }, ['index.html'])],
      ['no capture.css', pageDir('no-css', { 'capture.js': '' }, ['capture.css'])],
    ];
    for (const [label, dir] of cases) {
      const path = await dir;
      expect(() => createVaultCapturePage({ enabled: true, dir: path }), label).toThrow(VaultCapturePageError);
    }
  });

  it('serves the built page from the installed @tm8/vault, under the headers the page itself declares', async () => {
    const page = createVaultCapturePage({ enabled: true });
    const doc = get(page, '/vault/capture/import');
    expect(doc.status).toBe(200);
    expect(doc.body).toContain('assets/capture.js');
    expect(get(page, '/vault/capture/assets/capture.js').status).toBe(200);
    const built = await import(pathToFileURL(join(vaultCapturePageDir(), 'dist', 'headers.js')).href) as { CAPTURE_RESPONSE_HEADERS: unknown };
    expect(CAPTURE_RESPONSE_HEADERS).toEqual(built.CAPTURE_RESPONSE_HEADERS);
  });
});
