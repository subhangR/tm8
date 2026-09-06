/**
 * THE UI BUNDLE, THROUGH THE PIPELINE.
 *
 * Every property asserted here is a property of DISPATCH — of the order the
 * frame consults handlers in, and of what the static handler does with a path
 * once it gets one. None of them can be seen by calling `createStaticHandler`
 * directly; they need a request.
 *
 *  · `/v2` still wins over static, because a static handler that could shadow
 *    the API is the failure `static.ts` is written to prevent;
 *  · the SPA fallback covers extension-less CLIENT ROUTES only, so a missing
 *    `.js` 404s honestly instead of answering HTML with a 200 — the failure
 *    mode that makes SPA bugs unreadable;
 *  · the traversal guard holds against `../` in every encoding;
 *  · dispatch is guarded on `method === 'GET'`.
 *
 * This file was `static-ui-mount.test.ts` until 2026-09-06, when the second UI
 * package was deleted and `mountPath` went with it. The mount-specific cases
 * went too; everything above is about the bundle that is still served, and was
 * being covered here and nowhere else.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../src/facade/index.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import { createStaticHandler } from '../src/http/static.js';

const TEST_CONFIG = {
  host: '127.0.0.1',
  port: 0,
  uiDir: undefined,
  maxBodyBytes: 1024 * 1024,
  databaseUrl: undefined,
};

/** A bundle on disk: an index and one hashed asset. */
function makeBundle(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tm8-ui-${marker}-`));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><title>${marker}</title>`);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), `export const which = '${marker}';`);
  return dir;
}

describe('the UI bundle served at the root', () => {
  let server: FacadeServer;
  let base: string;
  let secretDir: string;

  beforeAll(async () => {
    const productDir = makeBundle('product');

    // A file OUTSIDE the root, to prove the traversal guard bites.
    secretDir = mkdtempSync(join(tmpdir(), 'tm8-secret-'));
    writeFileSync(join(secretDir, 'secret.txt'), 'not yours');

    // An empty registry: nothing here dispatches an operation. The `/v2` case
    // below asserts that the API surface still ANSWERS rather than falling
    // through to the bundle, and an unknown operation answers that just as well.
    server = createFacadeServer({
      config: TEST_CONFIG,
      registry: new HandlerRegistry(),
      staticHandler: createStaticHandler(productDir),
    });
    ({ url: base } = await server.listen());
  });

  afterAll(async () => {
    await server.close();
  });

  const body = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, text: await res.text() };
  };

  it('serves the bundle at the root', async () => {
    const res = await body('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('product');
  });

  it('serves the bundle its assets', async () => {
    expect((await body('/assets/app.js')).text).toContain('product');
  });

  it('answers a client route with the SPA fallback', async () => {
    const res = await body('/s/some-space/tasks');
    expect(res.status).toBe(200);
    expect(res.text).toContain('product');
  });

  it('404s a missing asset instead of returning HTML', async () => {
    // The SPA fallback covers extension-less CLIENT ROUTES only. A missing
    // `.js` is a broken build, and answering it with index.html and a 200 is
    // the thing that makes SPA bugs unreadable.
    const res = await fetch(`${base}/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<!doctype');
  });

  it('never lets the bundle shadow the API', async () => {
    const res = await fetch(`${base}/v2/nope/nope`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<!doctype');
  });

  it('keeps the traversal guard, in every encoding', async () => {
    for (const attempt of [
      '/../../etc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      `/..${secretDir}/secret.txt`,
    ]) {
      const res = await fetch(`${base}${attempt}`);
      expect(await res.text()).not.toContain('not yours');
    }
  });

  it('dispatches on GET only', async () => {
    // `server.ts` guards static dispatch on `method === 'GET'`, so a HEAD
    // reaches no handler and 404s against a server that IS serving the bundle.
    expect((await fetch(`${base}/index.html`)).status).toBe(200);
    expect((await fetch(`${base}/index.html`, { method: 'HEAD' })).status).toBe(404);
  });
});

describe('with no bundle configured', () => {
  let server: FacadeServer;
  let base: string;

  beforeAll(async () => {
    // The dev posture: TM8_UI_DIR unset, the handler absent, and unknown paths
    // fall through to the frame's `not_found` rather than to HTML.
    server = createFacadeServer({
      config: TEST_CONFIG,
      registry: new HandlerRegistry(),
    });
    ({ url: base } = await server.listen());
  });

  afterAll(async () => {
    await server.close();
  });

  it('404s an asset path honestly', async () => {
    const res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(404);
  });
});
