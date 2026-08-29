/**
 * The PWA contract — the parts of it a unit test can honestly hold.
 *
 * READ THIS BEFORE ADDING TO THIS FILE. vitest cannot see almost anything this
 * lane does: jsdom loads no stylesheets, runs no service worker, has no Cache
 * Storage and cannot reload a page with the network cut. The behavioural proof
 * lives in `e2e/pwa-verify.mjs`, which drives a real prod build in a real Chrome
 * over a real secure origin. Do not try to move those assertions here; they will
 * either be untestable or, worse, pass vacuously.
 *
 * What IS worth holding here is the set of facts that are pure text and that a
 * future edit could silently drop: the manifest's required fields, the meta tags
 * an installed app needs, and — most importantly — the ruling that /v2 is never
 * cached. The last one is a TRIPWIRE. It exists because a service worker is the
 * one place someone could reverse that ruling and no reviewer would look.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SW_SOURCE = read('src/pwa/service-worker.js');
const INDEX_HTML = read('index.html');
const MANIFEST = JSON.parse(read('public/manifest.webmanifest'));

/**
 * Pulls the real `isApiRequest` out of the real worker source and runs it.
 *
 * This is not a string match dressed up as a test: the function under test is
 * the exact text that ships in `sw.js`, so weakening the guard fails these
 * cases. The worker is a classic (non-module) worker and cannot be imported, and
 * that is the trade this buys around.
 */
function extractIsApiRequest(): (url: URL) => boolean {
  const match = SW_SOURCE.match(/function isApiRequest\(url\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('isApiRequest not found — did the guard get renamed?');
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}; return isApiRequest;`)() as (url: URL) => boolean;
}

describe('the ruling: /v2 is never cached', () => {
  const isApiRequest = extractIsApiRequest();
  const u = (p: string) => new URL(`https://tm8.example${p}`);

  it.each([
    '/v2',
    '/v2/',
    '/v2/entities.get',
    '/v2/collections.query',
    '/v2/messages.post',
    '/v2/sessions.stream',
    '/health',
  ])('treats %s as API traffic the worker must not touch', (path) => {
    expect(isApiRequest(u(path))).toBe(true);
  });

  it.each([
    '/',
    '/index.html',
    '/assets/index-abc123.js',
    '/assets/index-abc123.css',
    '/fonts/HankenGrotesk-400-latin.woff2',
    '/icons/icon-512.png',
    '/v2extra',          // must not be caught by a sloppy prefix test
    '/nested/v2/thing',
  ])('does not misclassify %s as API traffic', (path) => {
    expect(isApiRequest(u(path))).toBe(false);
  });

  it('bypasses API requests BEFORE respondWith, so failure reaches the app', () => {
    // The order matters: a `return` inside the fetch handler leaves the request
    // to the network. If this ever became `respondWith(...)` the app could be
    // handed a cached body instead of the honest failure it renders its empty
    // state from.
    expect(SW_SOURCE).toMatch(/if \(isApiRequest\(url\)\) return;/);
  });

  it('never lists an API path as a cacheable static asset', () => {
    const prefixes = SW_SOURCE.match(/const STATIC_PREFIXES = \[(.*?)\];/s)?.[1] ?? '';
    const files = SW_SOURCE.match(/const STATIC_FILES = \[(.*?)\];/s)?.[1] ?? '';
    expect(prefixes).not.toMatch(/v2|health/);
    expect(files).not.toMatch(/v2|health/);
  });
});

describe('web app manifest', () => {
  it('declares the fields an install needs', () => {
    expect(MANIFEST.name).toBeTruthy();
    expect(MANIFEST.short_name).toBeTruthy();
    expect(MANIFEST.start_url).toBe('/');
    expect(MANIFEST.scope).toBe('/');
    expect(MANIFEST.display).toBe('standalone');
    expect(MANIFEST.theme_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(MANIFEST.background_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('carries 192, 512 and a MASKABLE 512', () => {
    const at = (sizes: string, purpose: string) => MANIFEST.icons
      .find((i: { sizes: string; purpose: string }) => i.sizes === sizes && i.purpose === purpose);
    expect(at('192x192', 'any')).toBeTruthy();
    expect(at('512x512', 'any')).toBeTruthy();
    expect(at('512x512', 'maskable')).toBeTruthy();
  });

  it('points every icon at a file that exists', () => {
    for (const icon of MANIFEST.icons) {
      expect(() => readFileSync(join(ROOT, 'public', icon.src)))
        .not.toThrow();
    }
  });
});

describe('index.html — the installed-app meta set', () => {
  it('opts into the display cutout, without which every safe-area inset is 0', () => {
    expect(INDEX_HTML).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
  });

  it('sets theme-color, and it MATCHES the header token it sits above', () => {
    // `.mobile-frame__header` is painted with --pn-surface and carries the
    // safe-area top padding, so it is the element under the status bar. If the
    // two ever drift the status bar becomes a visible band of a different white.
    const themeColor = INDEX_HTML.match(/name="theme-color" content="(#[0-9A-Fa-f]{6})"/)?.[1];
    const surface = read('src/styles/tokens.css')
      .match(/--pn-surface:\s*(#[0-9A-Fa-f]{6})/)?.[1];
    expect(themeColor).toBeTruthy();
    expect(surface).toBeTruthy();
    expect(themeColor!.toUpperCase()).toBe(surface!.toUpperCase());
    expect(MANIFEST.theme_color.toUpperCase()).toBe(surface!.toUpperCase());
  });

  it('links the manifest', () => {
    expect(INDEX_HTML).toMatch(/rel="manifest" href="\/manifest\.webmanifest"/);
  });

  it('carries the apple-mobile-web-app set, which iOS reads INSTEAD of the manifest', () => {
    expect(INDEX_HTML).toMatch(/name="apple-mobile-web-app-capable" content="yes"/);
    expect(INDEX_HTML).toMatch(/name="apple-mobile-web-app-status-bar-style"/);
    expect(INDEX_HTML).toMatch(/name="apple-mobile-web-app-title"/);
    expect(INDEX_HTML).toMatch(/rel="apple-touch-icon"/);
  });

  it('still references no third-party origin', () => {
    // The fonts were self-hosted in #34 precisely so an installed app with no
    // egress keeps its type. A re-introduced font CDN would undo that silently.
    expect(INDEX_HTML).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });
});

describe('the precache stays the shell', () => {
  it('injects an explicit file list, never a glob', () => {
    const plugin = read('vite-plugin-pwa-shell.ts');
    // The hazard this guards: `globPatterns: ['**/*.{js,css,html}']` would pull
    // the whole 6.9MB build — ~40 mermaid chunks, cytoscape, katex — on install.
    expect(plugin).not.toMatch(/globPatterns/);
    expect(plugin).toMatch(/chunk\.isEntry/);
  });

  it('reports its payload size on every build', () => {
    // A precache that silently grows back into "the entire build" is this lane's
    // whole failure mode. The printed number is what makes it visible.
    expect(read('vite-plugin-pwa-shell.ts')).toMatch(/precache \(sw\.js\)/);
  });
});
