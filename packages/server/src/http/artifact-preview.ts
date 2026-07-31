/**
 * The artifact-preview listener — the SECOND HTTP listener, whose only job is
 * serving untrusted bundle content from its own origin (TM8-ARTIFACTS-DESIGN
 * §9, user-ratified 2026-07-31: app `127.0.0.1:4610`, preview
 * `localhost:4613`; the origin-isolation boot refusal lives in ./config.ts).
 *
 * A separate router sharing NO middleware, by design (§9.4): no `/v2/*`
 * routes, no catalog, no cookie parsing, no `Set-Cookie`, no identity
 * resolution beyond capability lookup, no static fallback. The ONLY route is
 *
 *   GET /p/<previewSessionId>/<token>/<asset-path>
 *
 * with an empty asset path serving the revision's entrypoint at the directory
 * URL, so the bundle's own relative references resolve under the same
 * capability prefix. The token rides the path because an iframe cannot attach
 * headers; only its sha256 ever touches the database (§5.2), and the whole
 * URL is short-lived, viewer-bound, and revoked-on-delete (§9.5).
 *
 * Every response — asset or refusal — carries the §9.4 header set. The single
 * most important line is `sandbox allow-scripts` INSIDE the CSP header: a
 * preview URL opened TOP-LEVEL (pasted, linked, redirected) is still forced
 * into an opaque origin because the header travels with the response; the
 * iframe attribute alone would only cover the framed case.
 *
 * Asset lookup is an equality match on a stored path (`revision_id = $1 AND
 * path = $2`), then bytes by content hash through the blob store — there is
 * no filesystem-derived path in the route at all, so no traversal surface.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { DbClaims } from '../db/types.js';
import type { LoopbackOwner } from '../identity/loopback.js';
import type { PreviewConfig } from './config.js';

/** The narrow slice of `Db` this listener needs — injectable for tests. */
export interface PreviewDb {
  query<R = Record<string, unknown>>(
    claims: DbClaims,
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
}

/** The narrow slice of `W2BlobStore` this listener needs. */
export interface PreviewBlobReader {
  read(storagePath: string, expectedSpaceId: string): Promise<Buffer>;
}

export interface ArtifactPreviewServerOptions {
  readonly preview: PreviewConfig;
  /** The BIND address — shared with the app listener (both loopback). */
  readonly bindHost: string;
  readonly db: PreviewDb;
  readonly blobStore: PreviewBlobReader;
  readonly owner: () => Promise<LoopbackOwner>;
  readonly now?: () => Date;
}

export interface ArtifactPreviewServer {
  readonly http: Server;
  listen(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

/** `/p/<uuid>/<64-hex>/<rest>` — the one route. Token format is checked here
 * so a malformed capability never reaches the database. */
const ROUTE = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})\/(.*)$/;

interface SessionRow {
  artifact_entity_id: string;
  revision_id: string;
  space_id: string;
  viewer_identity_id: string;
  entrypoint_path: string;
  revoked_at: Date | string | null;
  expires_at: Date | string;
}

interface EntryRow {
  media_type: string;
  storage_path: string;
}

/** §9.4's all-deny Permissions-Policy, one directive per platform capability. */
const PERMISSIONS_POLICY = [
  'accelerometer', 'ambient-light-sensor', 'autoplay', 'battery', 'camera',
  'display-capture', 'encrypted-media', 'fullscreen', 'geolocation',
  'gyroscope', 'idle-detection', 'local-fonts', 'magnetometer', 'microphone',
  'midi', 'payment', 'picture-in-picture', 'publickey-credentials-get',
  'screen-wake-lock', 'serial', 'storage-access', 'usb', 'xr-spatial-tracking',
].map((name) => `${name}=()`).join(', ');

/**
 * The §9.4 policy, verbatim. `'unsafe-inline'`/`'unsafe-eval'` are kept ON
 * PURPOSE: the whole document is attacker-controlled by assumption, so nonces
 * buy nothing — what contains the bundle is `connect-src 'none'`, the opaque
 * origin, and the absence of anything privileged on this origin.
 */
function contentSecurityPolicy(preview: PreviewConfig): string {
  return [
    `default-src 'none'`,
    `script-src ${preview.origin} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${preview.origin} 'unsafe-inline'`,
    `img-src ${preview.origin} data: blob:`,
    `font-src ${preview.origin}`,
    `media-src ${preview.origin}`,
    `connect-src 'none'`,
    `worker-src 'none'`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `child-src 'none'`,
    `manifest-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors ${preview.frameAncestors.join(' ')}`,
    `sandbox allow-scripts`,
  ].join('; ');
}

export function createArtifactPreviewServer(opts: ArtifactPreviewServerOptions): ArtifactPreviewServer {
  const { preview, db, blobStore, owner } = opts;
  const now = opts.now ?? (() => new Date());
  const csp = contentSecurityPolicy(preview);

  const baseHeaders: Record<string, string> = {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'permissions-policy': PERMISSIONS_POLICY,
  };

  function refuse(res: ServerResponse, status: number, message: string): void {
    // Plain text, never HTML: a refusal must not be a document the browser
    // could interpret, and it must not reflect any request content.
    res.writeHead(status, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${message}\n`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      refuse(res, 405, 'preview assets are read-only');
      return;
    }

    // The INVERSE of the app's S2 partition: this socket answers ONLY to the
    // preview hostname. Reached by any other name — including the app's —
    // the origin split is being bypassed and the answer is a refusal.
    const host = req.headers.host;
    const hostname = host === undefined ? null : hostnameOf(host);
    if (hostname !== preview.host) {
      refuse(res, 403, `this origin serves artifact previews only as ${preview.origin}`);
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://preview.invalid').pathname;
    const match = ROUTE.exec(pathname);
    if (!match) {
      refuse(res, 404, 'no such preview');
      return;
    }
    const [, sessionId, token, rawPath] = match as unknown as [string, string, string, string];

    let assetPath: string;
    try {
      assetPath = decodeURIComponent(rawPath);
    } catch {
      refuse(res, 404, 'no such asset');
      return;
    }

    // Capability resolution: the row is found by (id, sha256(token)) under
    // the node owner's claims — the viewer is not known until the row is —
    // then EVERY content read below re-runs as the viewer under ordinary RLS,
    // so a viewer who lost access loses the preview mid-session (§9.5).
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const resolvedOwner = await owner();
    const ownerClaims: DbClaims = { identityId: resolvedOwner.identityId, nodeAdmin: resolvedOwner.isNodeAdmin };
    const sessions = await db.query<SessionRow>(
      ownerClaims,
      `select s.artifact_entity_id, s.revision_id, s.space_id, s.viewer_identity_id,
              s.revoked_at, s.expires_at, r.entrypoint_path
         from public.artifact_preview_sessions s
         join public.artifact_bundle_revisions r on r.id = s.revision_id
        where s.id = $1 and s.token_hash = $2`,
      [sessionId, tokenHash],
    );
    const session = sessions[0];
    if (!session) {
      refuse(res, 404, 'no such preview');
      return;
    }
    if (session.revoked_at !== null) {
      refuse(res, 403, 'this preview has been revoked');
      return;
    }
    if (new Date(session.expires_at).getTime() <= now().getTime()) {
      refuse(res, 401, 'this preview has expired');
      return;
    }

    const viewerClaims: DbClaims = { identityId: session.viewer_identity_id, nodeAdmin: false };
    // Soft delete and authorization in one read: RLS answers nothing for a
    // viewer who is no longer a member, and the predicate refuses a deleted
    // artifact — both land as the same honest `forbidden`.
    const visible = await db.query<{ id: string }>(
      viewerClaims,
      `select id from public.entities
        where id = $1 and kind = 'artifact' and deleted_at is null`,
      [session.artifact_entity_id],
    );
    if (!visible[0]) {
      refuse(res, 403, 'this preview is no longer available');
      return;
    }

    const path = assetPath === '' ? session.entrypoint_path : assetPath;
    const entries = await db.query<EntryRow>(
      viewerClaims,
      `select en.media_type, b.storage_path
         from public.artifact_bundle_entries en
         join public.stored_blobs b on b.id = en.blob_id
        where en.revision_id = $1 and en.path = $2`,
      [session.revision_id, path],
    );
    const entry = entries[0];
    if (!entry) {
      refuse(res, 404, 'no such asset');
      return;
    }

    const bytes = await blobStore.read(entry.storage_path, session.space_id);
    res.writeHead(200, {
      ...baseHeaders,
      'content-type': entry.media_type,
      'content-length': String(bytes.length),
    });
    res.end(method === 'HEAD' ? undefined : bytes);
  }

  const http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        refuse(res, 500, 'preview unavailable');
      } catch {
        res.destroy();
      }
    });
  });

  return {
    http,
    listen() {
      return new Promise((resolveListen, rejectListen) => {
        http.once('error', rejectListen);
        http.listen(preview.port, opts.bindHost, () => {
          http.removeListener('error', rejectListen);
          const address = http.address();
          const port = typeof address === 'object' && address !== null ? address.port : preview.port;
          resolveListen({ url: `http://${preview.host}:${port}`, port });
        });
      });
    },
    close() {
      // Idempotent: the bootstrap ties this into BOTH the composed server
      // close and the process shutdown chain, and the second call must not
      // turn a clean exit into an ERR_SERVER_NOT_RUNNING rejection.
      if (!http.listening) return Promise.resolve();
      return new Promise((resolveClose, rejectClose) =>
        http.close((e) => (e ? rejectClose(e) : resolveClose())),
      );
    },
  };
}

/** Hostname out of a Host header: strip the port, keep bracketed IPv6 whole. */
function hostnameOf(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? null : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.indexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}
