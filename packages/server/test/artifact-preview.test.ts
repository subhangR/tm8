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
    // Open network access (owner-ruled): CDN scripts, fonts, live https fetch
    // — but never a fetch to the http loopback app origin.
    expect(csp).toContain('script-src http://localhost:4613 https: data: blob:');
    expect(csp).toContain('connect-src https:');
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
    const request = (path: string, init?: { method?: string; host?: string; cookie?: string }) =>
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
    expect(csp).toContain('connect-src https:');
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
});
