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
 *
 * A handler can also be MOUNTED under a prefix (`mountPath`), which is how a
 * second bundle is served beside the product one: `TM8_UI_1_0_DIR` puts the
 * frozen 1.0 UI at `/ui-1.0/` on the same origin, so the version switch is a
 * navigation rather than a second process on a second port — and the session
 * cookie, which is what makes the switched-to UI usable at all, needs no
 * cross-origin story. A mounted handler claims ONLY its prefix and falls
 * through for everything else, so mounting one can never shadow the product
 * UI's routes.
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

/**
 * Where the frozen 1.0 UI answers.
 *
 * Both UI bundles hardcode this same string (they cannot import from the
 * server package), so it is duplicated in exactly three places and each one
 * names the other two: here, `tm8_ui_2.0/src/ui-version/`, and
 * `tm8-ui/vite.config.ts`'s `base`. Changing it means changing all three and
 * rebuilding the 1.0 bundle — its asset URLs are baked at build time.
 */
export const UI_1_0_MOUNT_PATH = '/ui-1.0';

export interface StaticHandler {
  /** Streams the asset and returns true, or returns false to fall through. */
  serve(pathname: string, res: ServerResponse): Promise<boolean>;
  readonly rootDir: string;
  /** The URL prefix this bundle answers under, or undefined when it is at `/`. */
  readonly mountPath: string | undefined;
}

export interface StaticHandlerOptions {
  /**
   * Serve this bundle under a URL prefix (`/ui-1.0`) instead of at the root.
   *
   * The prefix is stripped before the path is resolved against `uiDir`, so the
   * traversal guard below still compares against the real root — the mount is
   * a URL concern and never widens what the filesystem will hand out.
   */
  readonly mountPath?: string;
}

export function createStaticHandler(
  uiDir: string,
  options: StaticHandlerOptions = {},
): StaticHandler {
  const rootDir = resolve(uiDir);
  const mountPath = normalizeMountPath(options.mountPath);

  /**
   * Strip the mount prefix, or refuse the path outright.
   *
   * `undefined` means "not mine" and becomes a fall-through, NOT a 404: an
   * unmounted path has to reach the next handler, and a mounted handler that
   * answered for `/` would shadow the product UI entirely.
   *
   * `/ui-1.0` with no trailing slash maps to `/` rather than being refused —
   * that is the address a person types, and refusing it would make the switch
   * work only from a link that happened to carry the slash.
   */
  function stripMount(pathname: string): string | undefined {
    if (!mountPath) return pathname;
    if (pathname === mountPath) return '/';
    if (pathname.startsWith(`${mountPath}/`)) return pathname.slice(mountPath.length);
    return undefined;
  }

  async function resolveFile(pathname: string): Promise<string | undefined> {
    const mounted = stripMount(pathname);
    if (mounted === undefined) return undefined;
    const decoded = safeDecode(mounted);
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
    mountPath,
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

/**
 * `/ui-1.0`, `ui-1.0/` and `/ui-1.0/` all mean the same mount.
 *
 * A prefix that normalizes to `/` is rejected rather than accepted as "the
 * root": a caller asking to mount at `/` wants the plain handler and should
 * pass no `mountPath`, and silently treating it as root is how a second bundle
 * would come to shadow the first.
 */
function normalizeMountPath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = `/${raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
  if (trimmed === '/') {
    throw new Error('createStaticHandler: mountPath cannot be "/" — omit it to serve at the root');
  }
  return trimmed;
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
