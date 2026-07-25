/**
 * The serve-static seam for the built web UI.
 *
 * AM-1/T-D21: there is no desktop shell. `packages/ui` is a browser app —
 * Vite serves it on 4611 in dev, and in production tm8-server serves the
 * built bundle from `TM8_UI_DIR` on 4610. Same-origin by construction, which
 * is why the CORS posture (S4) can be "same-origin only, no exceptions".
 *
 * Boundaries this handler must never cross:
 * - it is only consulted AFTER `/v2/*` and `/health` have been ruled out, so
 *   it can never shadow an API route or turn a `not_found` into an index.html;
 * - resolved paths are checked to stay inside the configured root after
 *   symlink-free normalization (path-traversal guard, S11's spirit applied to
 *   static assets);
 * - a single-page-app fallback serves `index.html` for extension-less paths
 *   only, so a missing `/assets/x.js` 404s honestly instead of returning HTML
 *   with a 200 (the failure mode that makes SPA bugs unreadable).
 *
 * When `TM8_UI_DIR` is unset (dev), the handler is absent and unknown paths
 * fall through to the frame's `not_found`.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { BASE_SECURITY_HEADERS } from './security.js';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticHandler {
  /** Streams the asset and returns true, or returns false to fall through. */
  serve(pathname: string, res: ServerResponse): Promise<boolean>;
  readonly rootDir: string;
}

export function createStaticHandler(uiDir: string): StaticHandler {
  const rootDir = resolve(uiDir);

  async function resolveFile(pathname: string): Promise<string | undefined> {
    const decoded = safeDecode(pathname);
    if (decoded === undefined) return undefined;

    // Normalize BEFORE joining so `../` cannot escape, then verify the result
    // is still under the root — belt and braces, because one of the two alone
    // has historically been enough to get this wrong.
    const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const candidate = resolve(join(rootDir, relative));
    if (candidate !== rootDir && !candidate.startsWith(rootDir + sep)) return undefined;

    const direct = await statFile(candidate);
    if (direct) return candidate;

    // SPA fallback: extension-less paths are client routes, not missing assets.
    if (extname(relative) === '') {
      const indexHtml = join(rootDir, 'index.html');
      if (await statFile(indexHtml)) return indexHtml;
    }
    return undefined;
  }

  return {
    rootDir,
    async serve(pathname, res) {
      const file = await resolveFile(pathname);
      if (!file) return false;

      res.writeHead(200, {
        ...BASE_SECURITY_HEADERS,
        'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      });
      await new Promise<void>((resolveStream, rejectStream) => {
        const stream = createReadStream(file);
        stream.on('error', rejectStream);
        stream.on('end', resolveStream);
        stream.pipe(res);
      });
      return true;
    },
  };
}

async function statFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
