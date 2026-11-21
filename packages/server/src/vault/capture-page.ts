/**
 * Serves the standalone vault capture and import page
 * (packages/vault/capture-page; its README's "Serving (WS-A)" section is the
 * contract this file implements). Task 01a1fa87-dd1a, WS-A.
 *
 * THE PREFIX IS ALWAYS CLAIMED. `/vault/capture/*` never reaches the SPA's
 * static fallback, even with the vault off: a capture link carries its key in
 * the URL fragment, and the SPA is a larger page with no CSP whose scripts
 * could read location.hash. With the vault off the prefix answers 404 under
 * the same strict headers.
 *
 * WITH THE VAULT ON, every file is read into memory once at boot, and boot
 * fails if the page is not built (`npm run build` in the capture-page
 * directory; the server's `tsc -b` builds it through the vault package's
 * project reference). Only `capture.css` and the compiled module basenames in
 * `dist` are served as assets; every other `/vault/capture/*` path gets
 * `index.html`, which renders the capture form for a capture id, the import
 * form for `/vault/capture/import`, and a fixed invalid-link state otherwise.
 *
 * No identity is resolved and no cookie is read here. The page's API calls go
 * to /v2/vault through the relay, which authenticates them.
 */
import type { ServerResponse } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const VAULT_CAPTURE_PATH = '/vault/capture';
const ASSET_PREFIX = `${VAULT_CAPTURE_PATH}/assets/`;
const MODULE_NAME = /^[a-z0-9-]+\.js$/;

/**
 * Applied to the document, every asset and every error. A copy of
 * packages/vault/capture-page/src/headers.ts: that file is compiled for the
 * browser and is not importable here. test/vault/capture-page.test.ts pins
 * the two equal.
 */
export const CAPTURE_RESPONSE_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // The legacy form of frame-ancestors 'none', and no other origin may embed the page or its modules
  // (review addendum 2, C3). artifacts.tm8.sh is the same site as tm8.sh, so not same-site.
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

interface PageFile { readonly body: Buffer; readonly type: string }

export interface VaultCapturePage {
  matches(pathname: string): boolean;
  serve(method: string, pathname: string, res: ServerResponse, requestId: string): void;
}

export class VaultCapturePageError extends Error {
  constructor(message: string) {
    super(`vault capture page: ${message}`);
    this.name = 'VaultCapturePageError';
  }
}

/** The capture-page directory inside the installed @tm8/vault package. */
export function vaultCapturePageDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('@tm8/vault/capture-page/index.html'));
}

/** `enabled: false` claims the prefix and answers 404, reading no file. */
export function createVaultCapturePage(options: { enabled: boolean; dir?: string }): VaultCapturePage {
  const files = options.enabled ? loadFiles(options.dir ?? vaultCapturePageDir()) : null;
  return {
    matches: (pathname) => pathname === VAULT_CAPTURE_PATH || pathname.startsWith(`${VAULT_CAPTURE_PATH}/`),
    serve(method, pathname, res, requestId) {
      if (method !== 'GET' && method !== 'HEAD') {
        write(res, 405, { body: Buffer.from('method not allowed\n'), type: 'text/plain; charset=utf-8' }, requestId, method, { allow: 'GET, HEAD' });
        return;
      }
      if (!files) {
        write(res, 404, { body: Buffer.from('the vault is off on this node\n'), type: 'text/plain; charset=utf-8' }, requestId, method);
        return;
      }
      if (pathname.startsWith(ASSET_PREFIX)) {
        const asset = files.assets.get(pathname.slice(ASSET_PREFIX.length));
        if (!asset) {
          write(res, 404, { body: Buffer.from('not found\n'), type: 'text/plain; charset=utf-8' }, requestId, method);
          return;
        }
        write(res, 200, asset, requestId, method);
        return;
      }
      write(res, 200, files.index, requestId, method);
    },
  };
}

function loadFiles(dir: string): { index: PageFile; assets: ReadonlyMap<string, PageFile> } {
  const read = (name: string): Buffer => {
    try { return readFileSync(join(dir, name)); } catch { throw new VaultCapturePageError(`${name} is missing from ${dir}`); }
  };
  const index = { body: read('index.html'), type: 'text/html; charset=utf-8' };
  const assets = new Map<string, PageFile>([['capture.css', { body: read('capture.css'), type: 'text/css; charset=utf-8' }]]);
  let built: ReadonlySet<string>;
  try {
    built = new Set(readdirSync(join(dir, 'dist')).filter((name) => MODULE_NAME.test(name)));
  } catch {
    throw new VaultCapturePageError(`not built: run npm run build in ${dir}`);
  }
  // Only capture.js and what it imports, transitively. A module left in dist by an
  // incremental build after its source was deleted is never served.
  const queue = ['capture.js'];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (assets.has(name)) continue;
    if (!built.has(name)) throw new VaultCapturePageError(`not built: dist/${name} is missing from ${dir}`);
    const body = read(join('dist', name));
    assets.set(name, { body, type: 'text/javascript; charset=utf-8' });
    for (const match of body.toString('utf8').matchAll(LOCAL_IMPORT)) queue.push(match[1]!);
  }
  return { index, assets };
}

/** `from './x.js'`, `import './x.js'` and `import('./x.js')`: the only import forms the page's own test allows. */
const LOCAL_IMPORT = /\b(?:from|import)\s*\(?\s*['"]\.\/([a-z0-9-]+\.js)['"]/g;

function write(
  res: ServerResponse, status: number, file: PageFile, requestId: string, method: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...CAPTURE_RESPONSE_HEADERS,
    ...extra,
    'content-type': file.type,
    'content-length': String(file.body.length),
    'x-tm8-request-id': requestId,
  });
  res.end(method === 'HEAD' ? undefined : file.body);
}
