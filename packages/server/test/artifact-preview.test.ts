/**
 * The artifact-preview deployment (TM8-ARTIFACTS-DESIGN §9, amended
 * 2026-08-16: same-origin `/p/` route by DEFAULT, second origin on explicit
 * TM8_PREVIEW_HOST/PORT), proven at its layers:
 *
 *   1. BOOT — a default-config node resolves the preview to the APP origin
 *      (same-origin mount, previewUrl mintable with no TM8_PREVIEW_* at all).
 *      In explicit second-origin mode loadConfig still REFUSES a preview
 *      origin that coincides with the app origin, a preview HOST that equals
 *      the app host (port-only separation is not separation: cookies ignore
 *      ports), and an app allowlist that names the preview host.
 *   2. PARTITION — with a SECOND-ORIGIN preview configured, the app's S2/S3
 *      checks refuse the preview hostname; with the same-origin default (or
 *      no preview), the loopback trio stands unchanged — `localhost` reaches
 *      the UI with preview ON.
 *   3. HANDLER — one shared request handler (standalone listener AND the
 *      mounted `/p/` route): only GET/HEAD, capabilities by (sessionId,
 *      sha256(token)) and never by cookie, revocation/expiry/soft-delete
 *      enforced, and the hardened header set stamped on every response —
 *      `sandbox allow-scripts` inside the CSP header above all, because that
 *      is what keeps a TOP-LEVEL load of a leaked preview URL in an opaque
 *      origin. COEP `require-corp` is deliberately ABSENT (open network
 *      access: CDN assets ship no CORP header and would silently fail).
 */
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, ConfigError, type ServerConfig } from '../src/http/config.js';
import { checkHost, checkOrigin } from '../src/http/security.js';
import {
  createArtifactPreviewHandler,
  createArtifactPreviewServer,
  type ArtifactPreviewServer,
  type PreviewDb,
} from '../src/http/artifact-preview.js';
import { HandlerRegistry } from '../src/facade/index.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import type { DbClaims } from '../src/db/types.js';

const BASE_ENV = { TM8_DATABASE_URL: '', TM8_LAUNCH_BOOTSTRAP: '0' };

describe('§9.2 — boot resolution: same-origin default, second-origin refusals', () => {
  it('a DEFAULT-CONFIG node (no TM8_PREVIEW_* at all) resolves the preview to the app origin', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.preview).toBeDefined();
    expect(config.preview?.sameOrigin).toBe(true);
    expect(config.preview?.host).toBe('127.0.0.1');
    expect(config.preview?.port).toBe(4610);
    // The string previewStart mints previewUrl from — a1's config half: with
    // NO TM8_PREVIEW_* set, `artifacts.preview.start` has an origin to mint.
    expect(config.preview?.origin).toBe('http://127.0.0.1:4610');
    expect(config.preview?.frameAncestors).toContain('http://127.0.0.1:4610');
  });

  /**
   * The UI is served from a DIFFERENT origin than the API socket in every
   * topology this repo ships (vite dev :4612, local prod :7777, local staging
   * :8888, and the nginx boxes where the browser reaches an https name while
   * the node binds loopback). `frame-ancestors` built from the BIND address
   * alone therefore names an origin that never does the framing, and the
   * browser refuses to paint the frame — an empty box, no error text, because
   * the viewer's error state only covers a MISSING previewUrl.
   *
   * These lock the two ways the framing origin gets in. They are deliberately
   * about the CONFIG rather than the header string: the header assertions
   * above passed the whole time the frame was dead in a browser, which is
   * exactly why the defect survived to review.
   */
  it('TM8_PUBLIC_ORIGIN — the origin the node is REACHED BY — may frame the preview', () => {
    const config = loadConfig({ ...BASE_ENV, TM8_PUBLIC_ORIGIN: 'https://tm8.example.com:7777' });
    expect(config.preview?.frameAncestors).toContain('https://tm8.example.com:7777');
    // The bind origin stays, so a node that serves its own UI keeps working.
    expect(config.preview?.frameAncestors).toContain('http://127.0.0.1:4610');
  });

  it('TM8_PREVIEW_FRAME_ANCESTORS covers the origins the node cannot infer, and never duplicates', () => {
    const config = loadConfig({
      ...BASE_ENV,
      TM8_PUBLIC_ORIGIN: 'https://tm8.example.com:7777',
      // The bind origin, repeated on purpose, plus a vite dev origin.
      TM8_PREVIEW_FRAME_ANCESTORS: 'http://127.0.0.1:4610 http://127.0.0.1:4612',
    });
    const ancestors = config.preview?.frameAncestors ?? [];
    expect(ancestors).toContain('http://127.0.0.1:4612');
    expect(ancestors).toContain('https://tm8.example.com:7777');
    expect(ancestors.filter((a) => a === 'http://127.0.0.1:4610')).toHaveLength(1);
  });

  it('an explicit TM8_PREVIEW_HOST opts into the second origin (the ratified loopback pair)', () => {
    const config = loadConfig({ ...BASE_ENV, TM8_PREVIEW_HOST: 'localhost' });
    expect(config.preview?.sameOrigin).toBe(false);
    expect(config.preview?.host).toBe('localhost');
    expect(config.preview?.port).toBe(4613);
    expect(config.preview?.origin).toBe('http://localhost:4613');
    expect(config.preview?.frameAncestors).toContain('http://127.0.0.1:4610');
  });

  it('an explicit TM8_PREVIEW_PORT alone also opts into the second origin (harness escape hatch)', () => {
    const config = loadConfig({ ...BASE_ENV, TM8_PREVIEW_PORT: '0' });
    expect(config.preview?.sameOrigin).toBe(false);
    expect(config.preview?.host).toBe('localhost');
    expect(config.preview?.port).toBe(0);
  });

  it('refuses to boot when the two origins coincide, naming both origins and both config keys', () => {
    const boot = () =>
      loadConfig({ ...BASE_ENV, TM8_PREVIEW_HOST: '127.0.0.1', TM8_PREVIEW_PORT: '4610' });
    expect(boot).toThrow(ConfigError);
    try {
      boot();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('http://127.0.0.1:4610');
      expect(message).toContain('TM8_PREVIEW_HOST');
      expect(message).toContain('TM8_PREVIEW_PORT');
      expect(message).toContain('TM8_BIND');
      expect(message).toContain('TM8_PORT');
    }
  });

  it('refuses port-only separation — same host, different port', () => {
    const boot = () =>
      loadConfig({ ...BASE_ENV, TM8_PREVIEW_HOST: '127.0.0.1', TM8_PREVIEW_PORT: '4613' });
    expect(boot).toThrow(ConfigError);
    try {
      boot();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('http://127.0.0.1:4613');
      expect(message).toContain('http://127.0.0.1:4610');
      expect(message).toContain('TM8_PREVIEW_HOST');
      expect(message).toContain('TM8_BIND');
    }
  });

  it('refuses an app allowlist that names the SECOND-ORIGIN preview host (two names for one socket)', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, TM8_PREVIEW_HOST: 'localhost', TM8_ALLOWED_HOSTNAMES: 'localhost' }),
    ).toThrow(ConfigError);
  });

  it('with the same-origin default, an allowlist naming localhost is NOT a contradiction', () => {
    const config = loadConfig({ ...BASE_ENV, TM8_ALLOWED_HOSTNAMES: 'localhost' });
    expect(config.preview?.sameOrigin).toBe(true);
  });

  /**
   * PROXIED second origin (`TM8_PREVIEW_PUBLIC_ORIGIN`). The deployment the
   * refusals above could not see: behind nginx BOTH listeners bind
   * `127.0.0.1`, so every comparison against the bind host passes while the
   * public names are the only ones a browser ever uses. These lock the widened
   * comparison and the two facts staying separate — public origin for the
   * browser, `TM8_PREVIEW_PORT` for the socket nginx is pointed at.
   */
  const PUBLIC_PROD = {
    ...BASE_ENV,
    TM8_ENV: 'prod',
    TM8_PORT: '17777',
    TM8_ALLOWED_HOSTNAMES: 'tm8.sh',
    TM8_ALLOWED_ORIGINS: 'https://tm8.sh',
  };

  it('TM8_PREVIEW_PUBLIC_ORIGIN is what the BROWSER sees; TM8_PREVIEW_PORT stays the loopback bind', () => {
    const config = loadConfig({
      ...PUBLIC_PROD,
      TM8_PREVIEW_PUBLIC_ORIGIN: 'https://artifacts.tm8.sh',
      TM8_PREVIEW_PORT: '17778',
    });
    expect(config.preview?.sameOrigin).toBe(false);
    // The string minted into previewUrl and into every CSP source list. If
    // this were `http://127.0.0.1:17778` the frame would be unopenable from
    // https://tm8.sh — unreachable AND mixed content — which is exactly what
    // the pre-2026-08-17 code produced on this deployment.
    expect(config.preview?.origin).toBe('https://artifacts.tm8.sh');
    // The name the proxy forwards in `Host`, which the listener's own inverse
    // Host check compares against. Never the bind address.
    expect(config.preview?.host).toBe('artifacts.tm8.sh');
    // The socket. Separate fact, neither derivable from the other.
    expect(config.preview?.port).toBe(17778);
  });

  it('refuses a proxied preview origin that is the app PUBLIC origin, which the bind comparison cannot see', () => {
    // `TM8_BIND` is 127.0.0.1 and the preview would bind 17778 — distinct
    // host:port by every pre-existing check, and yet the same public origin
    // as the app, cookie jar included.
    const boot = () => loadConfig({ ...PUBLIC_PROD, TM8_PREVIEW_PUBLIC_ORIGIN: 'https://tm8.sh', TM8_PREVIEW_PORT: '17778' });
    expect(boot).toThrow(ConfigError);
    try {
      boot();
    } catch (err) {
      expect((err as Error).message).toContain('https://tm8.sh');
      expect((err as Error).message).toContain('TM8_PREVIEW_PUBLIC_ORIGIN');
    }
  });

  it('refuses a proxied preview host that only differs from an app origin by SCHEME (cookies ignore it)', () => {
    expect(() =>
      loadConfig({ ...PUBLIC_PROD, TM8_ENV: 'dev', TM8_PREVIEW_PUBLIC_ORIGIN: 'http://tm8.sh' }),
    ).toThrow(ConfigError);
  });

  it('refuses a proxied preview host the app is reached by via TM8_PUBLIC_ORIGIN alone', () => {
    // No TM8_ALLOWED_* at all: the ONLY statement that `app.example` is this
    // node is TM8_PUBLIC_ORIGIN, and it still has to count.
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        TM8_PUBLIC_ORIGIN: 'https://app.example',
        TM8_PREVIEW_PUBLIC_ORIGIN: 'https://app.example:8443',
      }),
    ).toThrow(ConfigError);
  });

  it('refuses TM8_PREVIEW_HOST and TM8_PREVIEW_PUBLIC_ORIGIN disagreeing rather than picking a winner', () => {
    expect(() =>
      loadConfig({ ...PUBLIC_PROD, TM8_PREVIEW_HOST: 'previews.tm8.sh', TM8_PREVIEW_PUBLIC_ORIGIN: 'https://artifacts.tm8.sh' }),
    ).toThrow(ConfigError);
    // Agreeing is fine — redundant, not contradictory.
    expect(
      loadConfig({ ...PUBLIC_PROD, TM8_PREVIEW_HOST: 'artifacts.tm8.sh', TM8_PREVIEW_PUBLIC_ORIGIN: 'https://artifacts.tm8.sh' })
        .preview?.origin,
    ).toBe('https://artifacts.tm8.sh');
  });

  it('holds TM8_PREVIEW_PUBLIC_ORIGIN to a bare origin, and to https in prod', () => {
    for (const bad of ['artifacts.tm8.sh', 'https://artifacts.tm8.sh/p/', 'https://artifacts.tm8.sh?x=1', 'https://u:p@artifacts.tm8.sh']) {
      expect(() => loadConfig({ ...PUBLIC_PROD, TM8_PREVIEW_PUBLIC_ORIGIN: bad })).toThrow(ConfigError);
    }
    // Plain http is a legitimate proxied origin on a dev box, and never in prod.
    expect(() => loadConfig({ ...PUBLIC_PROD, TM8_PREVIEW_PUBLIC_ORIGIN: 'http://artifacts.tm8.sh' })).toThrow(ConfigError);
    expect(
      loadConfig({ ...BASE_ENV, TM8_PREVIEW_PUBLIC_ORIGIN: 'http://artifacts.localhost' }).preview?.origin,
    ).toBe('http://artifacts.localhost');
  });

  /**
   * The trap this closes. A PRODUCTION node that simply drops the preview
   * variables gets the SAME-ORIGIN default, which serves agent-authored bundle
   * HTML from the origin holding `__Host-tm8-session` — with nothing but the
   * response CSP's `sandbox allow-scripts` between that and session takeover.
   * The port-only version of this violation has been a boot refusal since
   * §9.2; reaching it through a reverse proxy has to answer the same way,
   * because the failure is silent and looks exactly like a working node.
   *
   * Scoped to `TM8_ENV=prod` on purpose — same-origin-behind-https is a shape
   * this repo ships and the two frame-ancestors tests above depend on, so the
   * refusal fires where the operator has declared the node real and is a loud
   * boot line (main.ts) everywhere else.
   */
  it('refuses the SAME-ORIGIN default on a PROD node published under an https public origin', () => {
    const boot = () => loadConfig({ ...BASE_ENV, TM8_ENV: 'prod', TM8_PUBLIC_ORIGIN: 'https://tm8.sh' });
    expect(boot).toThrow(ConfigError);
    try {
      boot();
    } catch (err) {
      // The refusal has to name BOTH exits, or an operator in a hurry takes
      // the one that is not there.
      expect((err as Error).message).toContain('TM8_PREVIEW_PUBLIC_ORIGIN');
      expect((err as Error).message).toContain('TM8_PREVIEW_ENABLED=0');
    }
    // ...and both exits actually work.
    const prod = { ...BASE_ENV, TM8_ENV: 'prod', TM8_PUBLIC_ORIGIN: 'https://tm8.sh' };
    expect(loadConfig({ ...prod, TM8_PREVIEW_ENABLED: '0' }).preview).toBeUndefined();
    expect(loadConfig({ ...prod, TM8_PREVIEW_PUBLIC_ORIGIN: 'https://artifacts.tm8.sh' }).preview?.sameOrigin).toBe(false);
  });

  it('nothing LOCAL changes shape because that refusal exists', () => {
    // The default-config node, the http-published node, and the non-prod
    // https node all keep the ratified same-origin mount. This is the
    // blast-radius assertion for the refusal above.
    expect(loadConfig({ ...BASE_ENV }).preview?.sameOrigin).toBe(true);
    expect(loadConfig({ ...BASE_ENV, TM8_PUBLIC_ORIGIN: 'http://127.0.0.1:7777' }).preview?.sameOrigin).toBe(true);
    expect(loadConfig({ ...BASE_ENV, TM8_PUBLIC_ORIGIN: 'https://staging.example' }).preview?.sameOrigin).toBe(true);
    expect(loadConfig({ ...BASE_ENV, TM8_ENV: 'prod' }).preview?.sameOrigin).toBe(true);
  });

  it('the proxied public origin is what frames and what the bundle may talk to', () => {
    const config = loadConfig({
      ...PUBLIC_PROD,
      TM8_PREVIEW_PUBLIC_ORIGIN: 'https://artifacts.tm8.sh',
      TM8_PREVIEW_PORT: '17778',
      TM8_PREVIEW_FRAME_ANCESTORS: 'https://tm8.sh',
    });
    // The document that embeds the frame is the public app, never the bind
    // origin — the defect this file already documents, in its proxied form.
    expect(config.preview?.frameAncestors).toContain('https://tm8.sh');
  });

  it('TM8_PREVIEW_ENABLED=0 disables the preview origin entirely', () => {
    const config = loadConfig({ ...BASE_ENV, TM8_PREVIEW_ENABLED: '0' });
    expect(config.preview).toBeUndefined();
    // ...and with it the partition: localhost is an app name again.
    expect(loadConfig({ ...BASE_ENV, TM8_PREVIEW_ENABLED: '0', TM8_ALLOWED_HOSTNAMES: 'localhost' }).preview).toBeUndefined();
  });
});

describe('§9.3 — the S2/S3 partition on the app socket (second-origin mode only)', () => {
  const withPreview: ServerConfig = {
    host: '127.0.0.1',
    port: 4610,
    uiDir: undefined,
    maxBodyBytes: 1024,
    databaseUrl: undefined,
    preview: {
      host: 'localhost',
      port: 4613,
      origin: 'http://localhost:4613',
      sameOrigin: false,
      frameAncestors: ['http://127.0.0.1:4610'],
    },
  };
  const withoutPreview: ServerConfig = { ...withPreview, preview: undefined } as ServerConfig;
  const withSameOriginPreview: ServerConfig = {
    ...withPreview,
    preview: {
      host: '127.0.0.1',
      port: 4610,
      origin: 'http://127.0.0.1:4610',
      sameOrigin: true,
      frameAncestors: ['http://127.0.0.1:4610'],
    },
  };

  it('a5 — with the SAME-ORIGIN default, the UI stays reachable at localhost with preview ON', () => {
    // The exact regression that kept preview disabled in every environment:
    // enabling it deleted `localhost` from the app's own host allowlist.
    expect(checkHost({ host: 'localhost:4610' }, withSameOriginPreview).refusal).toBeUndefined();
    expect(checkHost({ host: '127.0.0.1:4610' }, withSameOriginPreview).refusal).toBeUndefined();
    expect(checkOrigin({ origin: 'http://localhost:4610' }, withSameOriginPreview).refusal).toBeUndefined();
  });

  it('the app refuses Host: localhost when the preview owns that name', () => {
    expect(checkHost({ host: 'localhost:4610' }, withPreview).refusal?.code).toBe('forbidden');
    expect(checkHost({ host: 'localhost' }, withPreview).refusal?.code).toBe('forbidden');
    // The rest of the trio still answers.
    expect(checkHost({ host: '127.0.0.1:4610' }, withPreview).refusal).toBeUndefined();
    expect(checkHost({ host: '[::1]:4610' }, withPreview).refusal).toBeUndefined();
  });

  it('the app refuses Origin: http://localhost:* for the same reason', () => {
    expect(checkOrigin({ origin: 'http://localhost:4612' }, withPreview).refusal?.code).toBe('forbidden');
    expect(checkOrigin({ origin: 'http://127.0.0.1:4612' }, withPreview).refusal).toBeUndefined();
  });

  it('without a preview configured the loopback trio stands unchanged', () => {
    expect(checkHost({ host: 'localhost:4610' }, withoutPreview).refusal).toBeUndefined();
    expect(checkOrigin({ origin: 'http://localhost:4612' }, withoutPreview).refusal).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The listener, against a scripted database. The stub answers the three
// queries the listener makes in order (session, visibility, entry) and
// records the claims each ran under — the viewer re-check under RLS is a
// claims assertion, not a mock convenience.
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_ID = '019fb6a7-0000-7000-8000-000000000001';
const TOKEN = 'a'.repeat(64);
const TOKEN_HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const OWNER_ID = 'identity-owner';
const VIEWER_ID = 'identity-viewer';

interface ScriptedRows {
  session?: Record<string, unknown>[];
  visibility?: Record<string, unknown>[];
  entry?: Record<string, unknown>[];
}

function scriptedDb(rows: ScriptedRows): PreviewDb & { calls: Array<{ claims: DbClaims; sql: string }> } {
  const calls: Array<{ claims: DbClaims; sql: string }> = [];
  return {
    calls,
    async query<R>(claims: DbClaims, sql: string): Promise<R[]> {
      calls.push({ claims, sql });
      if (sql.includes('artifact_preview_sessions')) return (rows.session ?? []) as R[];
      if (sql.includes('from public.entities')) return (rows.visibility ?? []) as R[];
      if (sql.includes('artifact_bundle_entries')) return (rows.entry ?? []) as R[];
      throw new Error(`unscripted query: ${sql}`);
    },
  };
}

const FUTURE = new Date(Date.now() + 600_000).toISOString();

function liveSession(): Record<string, unknown> {
  return {
    artifact_entity_id: '019fb6a7-0000-7000-8000-00000000000a',
    revision_id: '019fb6a7-0000-7000-8000-00000000000b',
    space_id: '019fb6a7-0000-7000-8000-00000000000c',
    viewer_identity_id: VIEWER_ID,
    entrypoint_path: 'index.html',
    revoked_at: null,
    expires_at: FUTURE,
  };
}

let server: ArtifactPreviewServer | undefined;
afterEach(async () => {
  await server?.close().catch(() => undefined);
  server = undefined;
});

async function startListener(rows: ScriptedRows, bytes = Buffer.from('<!doctype html><h1>hi</h1>')) {
  const db = scriptedDb(rows);
  server = createArtifactPreviewServer({
    preview: { host: 'localhost', port: 0, origin: 'http://localhost:4613', sameOrigin: false, frameAncestors: ['http://127.0.0.1:4610'] },
    bindHost: '127.0.0.1',
    db,
    blobStore: { read: async () => bytes },
    owner: async () => ({
      identityId: OWNER_ID,
      accountId: 'acct',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    }),
  });
  const { port } = await server.listen();
  // Raw node:http, not fetch: undici refuses to override the Host header,
  // and the Host header is exactly what these cases exercise.
  const request = (path: string, init?: { method?: string; host?: string }) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path,
            method: init?.method ?? 'GET',
            headers: { host: init?.host ?? 'localhost:4613' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
  return { db, request, port };
}

const GOOD_PATH = `/p/${SESSION_ID}/${TOKEN}/`;

describe('the preview listener', () => {
  it('serves the entrypoint at the directory URL with the full §9.4 header set', async () => {
    const { db, request } = await startListener({
      session: [liveSession()],
      visibility: [{ id: 'x' }],
      entry: [{ media_type: 'text/html; charset=utf-8', storage_path: 'spaces/s/blob' }],
    });
    const res = await request(GOOD_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<h1>hi</h1>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');

    const csp = String(res.headers['content-security-policy'] ?? '');
    // The single most important line in the policy (§9.4): a top-level load
    // of a leaked preview URL is STILL sandboxed into an opaque origin.
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain(`default-src 'none'`);
    // Open network access (owner-ruled): CDN scripts, fonts, live https fetch,
    // plus the preview origin's own /p/ subtree so a bundle can fetch() its
    // own files on an http dev node — but never the tm8 API paths.
    expect(csp).toContain('script-src http://localhost:4613 https: data: blob:');
    expect(csp).toContain('connect-src http://localhost:4613/p/ https:');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(csp).not.toContain(`connect-src 'none'`);
    expect(csp).toContain('frame-ancestors http://127.0.0.1:4610');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    // `cross-origin`, NOT `same-origin`: the sandboxed document is
    // opaque-origin, so its own /p/ subresource loads are cross-origin to
    // the browser — same-origin CORP blocks every multi-file bundle's own
    // scripts (found in a live browser run, 2026-08-17).
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    // a6 (server half) — COEP require-corp is DROPPED: CDN assets carry no
    // CORP header and would silently fail under it, defeating open network.
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['set-cookie']).toBeUndefined();

    // The capability row was resolved as the owner; every CONTENT read ran as
    // the recorded viewer under ordinary RLS.
    expect(db.calls[0]?.claims.identityId).toBe(OWNER_ID);
    expect(db.calls[1]?.claims).toEqual({ identityId: VIEWER_ID, nodeAdmin: false });
    expect(db.calls[2]?.claims).toEqual({ identityId: VIEWER_ID, nodeAdmin: false });
  });

  it('answers ONLY to the preview hostname — the inverse of the app partition', async () => {
    const { request } = await startListener({ session: [liveSession()] });
    const res = await request(GOOD_PATH, { host: '127.0.0.1:4613' });
    expect(res.status).toBe(403);
  });

  it('a wrong token is not_found, never an oracle', async () => {
    const { request } = await startListener({ session: [] });
    const res = await request(`/p/${SESSION_ID}/${'b'.repeat(64)}/`);
    expect(res.status).toBe(404);
  });

  it('a revoked capability is forbidden', async () => {
    const { request } = await startListener({
      session: [{ ...liveSession(), revoked_at: new Date().toISOString() }],
    });
    expect((await request(GOOD_PATH)).status).toBe(403);
  });

  it('an expired capability is unauthenticated (design test matrix)', async () => {
    const { request } = await startListener({
      session: [{ ...liveSession(), expires_at: new Date(Date.now() - 1000).toISOString() }],
    });
    expect((await request(GOOD_PATH)).status).toBe(401);
  });

  it('a soft-deleted or RLS-invisible artifact is forbidden at the viewer re-check', async () => {
    const { request } = await startListener({ session: [liveSession()], visibility: [] });
    expect((await request(GOOD_PATH)).status).toBe(403);
  });

  it('an asset not in the manifest is not_found (equality lookup, no traversal)', async () => {
    const { db, request } = await startListener({
      session: [liveSession()],
      visibility: [{ id: 'x' }],
      entry: [],
    });
    expect((await request(`/p/${SESSION_ID}/${TOKEN}/../../etc/passwd`)).status).toBe(404);
    // The traversal-shaped string went to the database as an equality
    // parameter or not at all — never near a filesystem join.
    expect(db.calls.every((c) => !c.sql.includes('..'))).toBe(true);
  });

  it('mutations are refused outright', async () => {
    const { request } = await startListener({ session: [liveSession()] });
    expect((await request(GOOD_PATH, { method: 'POST' })).status).toBe(405);
    expect((await request(GOOD_PATH, { method: 'DELETE' })).status).toBe(405);
  });

  it('has no /v2 surface at all', async () => {
    const { request } = await startListener({});
    expect((await request('/v2/entities')).status).toBe(404);
    expect((await request('/')).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The SAME-ORIGIN mount (the default deployment): the identical handler,
// dispatched as the `/p/` route inside the app pipeline. Same scripted
// database, same header claims — plus the two properties only this mount has
// to prove: cookie identity is never consulted, and the app socket answers
// to `localhost` with preview ON.
// ─────────────────────────────────────────────────────────────────────────────

describe('the same-origin /p/ route on the app socket', () => {
  let facade: FacadeServer | undefined;
  afterEach(async () => {
    await facade?.close().catch(() => undefined);
    facade = undefined;
  });

  async function startMounted(rows: ScriptedRows, bytes = Buffer.from('<!doctype html><h1>hi</h1>')) {
    const db = scriptedDb(rows);
    const identityResolver = vi.fn(async () => ({ kind: 'anonymous' as const }));
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024 * 1024,
      databaseUrl: undefined,
      preview: {
        host: '127.0.0.1',
        port: 4610,
        origin: 'http://127.0.0.1:4610',
        sameOrigin: true,
        frameAncestors: ['http://127.0.0.1:4610'],
      },
    };
    facade = createFacadeServer({
      config,
      registry: new HandlerRegistry(),
      identityResolver,
      artifactPreviewRoute: createArtifactPreviewHandler({
        preview: config.preview!,
        db,
        blobStore: { read: async () => bytes },
        owner: async () => ({
          identityId: OWNER_ID,
          accountId: 'acct',
          username: 'owner',
          isNodeAdmin: true,
          isOwner: true,
        }),
      }),
    });
    const { port } = await facade.listen();
    const request = (path: string, init?: { method?: string; host?: string; cookie?: string; origin?: string }) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path,
              method: init?.method ?? 'GET',
              headers: {
                host: init?.host ?? `127.0.0.1:${port}`,
                ...(init?.cookie ? { cookie: init.cookie } : {}),
                ...(init?.origin ? { origin: init.origin } : {}),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => chunks.push(chunk));
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: Buffer.concat(chunks).toString('utf8'),
                }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        },
      );
    return { db, identityResolver, request, port };
  }

  it('a2 — serves bytes with the full hardened header set, COEP absent, on the APP socket', async () => {
    const { db, request } = await startMounted({
      session: [liveSession()],
      visibility: [{ id: 'x' }],
      entry: [{ media_type: 'text/html; charset=utf-8', storage_path: 'spaces/s/blob' }],
    });
    const res = await request(GOOD_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<h1>hi</h1>');
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain('sandbox allow-scripts');
    // Path-scoped self source: the bundle can fetch() its own /p/ files even
    // on an http node, and still cannot reach the tm8 API by fetch.
    expect(csp).toContain('connect-src http://127.0.0.1:4610/p/ https:');
    // ACAO * so the opaque-origin document's cors-mode fetch of its own
    // files is READABLE; the token in the path is the access control.
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(csp).toContain('frame-ancestors http://127.0.0.1:4610');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['set-cookie']).toBeUndefined();
    // The RLS claims discipline survives the mount: capability row as the
    // node owner, every content read as the recorded viewer.
    expect(db.calls[0]?.claims.identityId).toBe(OWNER_ID);
    expect(db.calls[1]?.claims).toEqual({ identityId: VIEWER_ID, nodeAdmin: false });
  });

  it('a5 — the route answers when the browser reaches the app as localhost', async () => {
    const { request } = await startMounted({
      session: [liveSession()],
      visibility: [{ id: 'x' }],
      entry: [{ media_type: 'text/html; charset=utf-8', storage_path: 'spaces/s/blob' }],
    });
    const res = await request(GOOD_PATH, { host: 'localhost:4610' });
    expect(res.status).toBe(200);
  });

  it('never consults cookie identity — the capability token in the path is the only auth', async () => {
    const { identityResolver, request } = await startMounted({
      session: [liveSession()],
      visibility: [{ id: 'x' }],
      entry: [{ media_type: 'text/html; charset=utf-8', storage_path: 'spaces/s/blob' }],
    });
    const served = await request(GOOD_PATH, { cookie: 'tm8_session=some-browser-cookie' });
    expect(served.status).toBe(200);
    expect(identityResolver).not.toHaveBeenCalled();
    await facade?.close();
    facade = undefined;
    // ...and a cookie CANNOT stand in for a token the database does not
    // know: same cookie, no capability row, refused. The route is not
    // reachable through cookie identity.
    const unknown = await startMounted({ session: [] });
    const refused = await unknown.request(`/p/${SESSION_ID}/${'b'.repeat(64)}/`, {
      cookie: 'tm8_session=some-browser-cookie',
    });
    expect(refused.status).toBe(404);
    expect(unknown.identityResolver).not.toHaveBeenCalled();
  });

  it('a3 — revoked is 403, expired is 401, through the mounted route', async () => {
    const revoked = await startMounted({
      session: [{ ...liveSession(), revoked_at: new Date().toISOString() }],
    });
    expect((await revoked.request(GOOD_PATH)).status).toBe(403);
    await facade?.close();
    facade = undefined;
    const expired = await startMounted({
      session: [{ ...liveSession(), expires_at: new Date(Date.now() - 1000).toISOString() }],
    });
    expect((await expired.request(GOOD_PATH)).status).toBe(401);
  });

  it('a4 — a viewer who lost access to the artifact gets nothing', async () => {
    const { request } = await startMounted({ session: [liveSession()], visibility: [] });
    expect((await request(GOOD_PATH)).status).toBe(403);
  });

  it('mutations under /p/ are refused by the handler, not routed to the catalog', async () => {
    const { request } = await startMounted({ session: [liveSession()] });
    expect((await request(GOOD_PATH, { method: 'POST' })).status).toBe(405);
  });

  it('a GET /p/ with Origin: null (the sandboxed frame fetching its OWN files) is served', async () => {
    // The preview document is opaque-origin BY DESIGN, so its cors-mode
    // fetch() of its own /p/ assets carries `Origin: null`. The /p/ dispatch
    // sits ahead of S3 for exactly this reason — S3 protects cookie-backed
    // paths, and this route has none (found live, 2026-08-17).
    const { request } = await startMounted({
      session: [liveSession()],
      visibility: [{ id: 'x' }],
      entry: [{ media_type: 'text/html; charset=utf-8', storage_path: 'spaces/s/blob' }],
    });
    const res = await request(GOOD_PATH, { origin: 'null' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('Origin: null on an API path is STILL refused — the S3 exemption is /p/-only', async () => {
    const { request } = await startMounted({ session: [liveSession()] });
    expect((await request('/v2/spaces', { origin: 'null' })).status).toBe(403);
  });

  it('a POST /p/ with Origin: null dies at the handler as 405, never reaching the catalog', async () => {
    const { request } = await startMounted({ session: [liveSession()] });
    expect((await request(GOOD_PATH, { method: 'POST', origin: 'null' })).status).toBe(405);
  });

  it('the /p/ dispatch still enforces the S2 host allowlist', async () => {
    const { request } = await startMounted({ session: [liveSession()] });
    expect((await request(GOOD_PATH, { host: 'evil.example:4610' })).status).toBe(403);
  });
});
