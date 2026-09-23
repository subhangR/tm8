/**
 * ONE UI BUNDLE, SERVED AT THE ROOT — through the pipeline.
 *
 * Until 2026-09-15 a second bundle was mounted beside this one under
 * `/ui-2.0/`, and this file was about dispatch order and prefix stripping.
 * The alternate UI package is gone and so is the mount, but the guarantees the
 * ROOT handler always owed are unchanged and still only a request can see
 * them:
 *
 *  · a client route resolves to index.html, so a deep link boots the app;
 *  · a missing `.js` 404s honestly rather than answering index.html with a
 *    200 — the thing that makes SPA bugs unreadable;
 *  · the traversal guard compares against the resolved root, so no path can
 *    walk out of the bundle;
 *  · `/v2` wins over the bundle, because a static handler that could shadow
 *    the API is the failure `static.ts` is written to prevent;
 *  · dispatch is guarded on `method === 'GET'`.
 *
 * The last case pins the removal itself: `/ui-2.0/` is now an ordinary unknown
 * path. If someone re-adds a mount, that case is where it should announce
 * itself rather than in a deploy.
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

describe('the product UI bundle at the root', () => {
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

  it('serves its assets', async () => {
    expect((await body('/assets/app.js')).text).toContain('product');
  });

  it('answers a client route with index.html', async () => {
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

  it('keeps the traversal guard', async () => {
    for (const attempt of [
      '/../../etc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      `/..${secretDir}/secret.txt`,
    ]) {
      const res = await fetch(`${base}${attempt}`);
      expect(await res.text()).not.toContain('not yours');
    }
  });

  it('dispatches on GET only — HEAD reaches no handler', async () => {
    expect((await fetch(`${base}/index.html`)).status).toBe(200);
    expect((await fetch(`${base}/index.html`, { method: 'HEAD' })).status).toBe(404);
  });

  it('has no second mount: /ui-2.0/ is an ordinary unknown path', async () => {
    // index.html specifically. Probing the directory would hit the SPA
    // fallback and answer 200 for a bundle that does not exist — which is how
    // the removed mount would look if it came back by accident.
    expect((await fetch(`${base}/ui-2.0/index.html`)).status).toBe(404);
  });
});
