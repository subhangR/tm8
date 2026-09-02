/**
 * TWO UI BUNDLES ON ONE ORIGIN, through the pipeline.
 *
 * The version switch in the product UI is a plain navigation to `/ui-1.0/`.
 * Everything that makes that navigation land on the OTHER bundle rather than
 * re-rendering the product one is a property of dispatch order and prefix
 * stripping, and only a request can see it:
 *
 *  · the mounted handler is consulted BEFORE the root handler. The root
 *    handler answers extension-less paths with its own index.html, so the
 *    reverse order would serve the 2.0 shell at the 1.0 address with a 200 —
 *    a switch that silently does nothing, which is worse than a 404 because
 *    it looks like it worked;
 *  · the mount claims ONLY its prefix, so adding one cannot cost the product
 *    UI a route;
 *  · the traversal guard still compares against the real root after the
 *    prefix comes off — a mount is a URL concern and must not widen what the
 *    filesystem hands out;
 *  · `/v2` still wins over both, because a static handler that could shadow
 *    the API is the failure `static.ts` is written to prevent.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../src/facade/index.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import { createStaticHandler, UI_1_0_MOUNT_PATH } from '../src/http/static.js';

const TEST_CONFIG = {
  host: '127.0.0.1',
  port: 0,
  uiDir: undefined,
  ui10Dir: undefined,
  maxBodyBytes: 1024 * 1024,
  databaseUrl: undefined,
};

/** A bundle on disk: an index and one hashed asset, enough to tell two apart. */
function makeBundle(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tm8-ui-${marker}-`));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><title>${marker}</title>`);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), `export const which = '${marker}';`);
  return dir;
}

describe('the 1.0 UI mount beside the product UI', () => {
  let server: FacadeServer;
  let base: string;
  let secretDir: string;

  beforeAll(async () => {
    const productDir = makeBundle('ui-2.0');
    const legacyDir = makeBundle('ui-1.0');

    // A file OUTSIDE both roots, to prove the traversal guard still bites once
    // the mount prefix has been stripped.
    secretDir = mkdtempSync(join(tmpdir(), 'tm8-secret-'));
    writeFileSync(join(secretDir, 'secret.txt'), 'not yours');

    // An empty registry: nothing here dispatches an operation. The `/v2` case
    // below asserts that the API surface still ANSWERS rather than falling
    // through to a bundle, and an unknown operation answers that just as well.
    server = createFacadeServer({
      config: TEST_CONFIG,
      registry: new HandlerRegistry(),
      staticHandler: createStaticHandler(productDir),
      staticMounts: [createStaticHandler(legacyDir, { mountPath: UI_1_0_MOUNT_PATH })],
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

  it('serves the product bundle at the root', async () => {
    const res = await body('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ui-2.0');
  });

  it('serves the 1.0 bundle under its mount, not the product one', async () => {
    const res = await body('/ui-1.0/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ui-1.0');
    expect(res.text).not.toContain('ui-2.0');
  });

  it('answers the mount with no trailing slash — the address a person types', async () => {
    const res = await body('/ui-1.0');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ui-1.0');
  });

  it('serves each bundle its OWN assets at the same relative path', async () => {
    expect((await body('/assets/app.js')).text).toContain('ui-2.0');
    expect((await body('/ui-1.0/assets/app.js')).text).toContain('ui-1.0');
  });

  it('gives the mounted bundle its own SPA fallback', async () => {
    // A client route inside the 1.0 app resolves to the 1.0 index, never the
    // product one — otherwise a deep link into the alternate UI boots the app
    // it was trying to leave.
    const res = await body('/ui-1.0/s/some-space/tasks');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ui-1.0');
  });

  it('404s a missing asset under the mount instead of returning HTML', async () => {
    // The SPA fallback covers extension-less CLIENT ROUTES only. A missing
    // `.js` is a broken build, and answering it with index.html and a 200 is
    // the thing that makes SPA bugs unreadable. Asserted on the content type
    // rather than the body: the honest 404 quotes the path back, so a body
    // check would match the mount's own name.
    const res = await fetch(`${base}/ui-1.0/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<!doctype');
  });

  it('never lets the mount shadow the API', async () => {
    const res = await fetch(`${base}/v2/nope/nope`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.text())).not.toContain('<!doctype');
  });

  it('keeps the traversal guard after the prefix is stripped', async () => {
    for (const attempt of [
      '/ui-1.0/../../etc/passwd',
      '/ui-1.0/%2e%2e/%2e%2e/etc/passwd',
      `/ui-1.0/..${secretDir}/secret.txt`,
    ]) {
      const res = await fetch(`${base}${attempt}`);
      expect(await res.text()).not.toContain('not yours');
    }
  });

  it('answers the probe the switch uses — GET, because HEAD reaches no handler', async () => {
    // The dispatch is guarded on `method === 'GET'`, so a HEAD probe would 404
    // against a server that IS serving the bundle. The control probes with GET
    // for exactly this reason; this case pins the fact it depends on.
    expect((await fetch(`${base}/ui-1.0/index.html`)).status).toBe(200);
    expect((await fetch(`${base}/ui-1.0/index.html`, { method: 'HEAD' })).status).toBe(404);
  });

  it('refuses a mount at the root rather than shadowing the product UI', () => {
    expect(() => createStaticHandler('/tmp', { mountPath: '/' })).toThrow(/cannot be "\/"/);
  });
});

describe('with no 1.0 bundle configured', () => {
  let server: FacadeServer;
  let base: string;

  beforeAll(async () => {
    // The default posture: an operator who set no TM8_UI_1_0_DIR gets no mount,
    // and the switch control in the product UI reports itself unavailable
    // rather than offering a door onto nothing.
    server = createFacadeServer({
      config: TEST_CONFIG,
      registry: new HandlerRegistry(),
      staticHandler: createStaticHandler(makeBundle('ui-2.0')),
    });
    ({ url: base } = await server.listen());
  });

  afterAll(async () => {
    await server.close();
  });

  it('404s the probe the switch uses, so the control refuses honestly', async () => {
    // index.html specifically: probing the directory would hit the product
    // UI's SPA fallback and answer 200 for a bundle that is not there.
    const res = await fetch(`${base}/ui-1.0/index.html`);
    expect(res.status).toBe(404);
  });
});
