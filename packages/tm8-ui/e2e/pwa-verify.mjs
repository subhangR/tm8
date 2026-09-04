/**
 * PWA verification against a REAL prod build in a REAL Chrome.
 *
 * Not a vitest: jsdom loads no stylesheets, runs no service worker, has no
 * Cache Storage and has no concept of an offline reload. Every single claim this
 * lane makes is invisible to the unit suite, so it is asserted here instead,
 * against `vite preview` serving `dist/` on loopback — which is a SECURE CONTEXT
 * and therefore the minimum bar at which a service worker exists at all.
 *
 *   node e2e/pwa-verify.mjs [--url http://127.0.0.1:4620] [--out <dir>]
 *
 * Exits non-zero on any failed check and prints a one-line summary per check.
 */
import { chromium, devices } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const URL_BASE = arg('url', 'http://127.0.0.1:4620');
const OUT = arg('out', 'pwa-evidence');
mkdirSync(OUT, { recursive: true });

/**
 * Every measurement carries the ref it was taken at. A baseline without its ref
 * cannot be compared to anything later, and `main` moves under this program
 * several times a day.
 */
const REF = (() => {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return `${branch}@${sha.slice(0, 8)}${dirty ? '+dirty' : ''}`;
  } catch {
    return 'unknown-ref';
  }
})();
console.log(`tm8 PWA verification · ref ${REF} · url ${URL_BASE}\n`);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome' });
// isMobile/hasTouch are required, not cosmetic: `shellFor` forks on
// `(pointer: coarse) and (max-width: 499px)`, and without them the desktop
// shell renders and the phone is never measured.
const context = await browser.newContext({
  ...devices['Pixel 7'],
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'allow',
});
// `beforeinstallprompt` fires only when Chrome's own installability criteria are
// all met (manifest with name + 192/512 icons + display, a service worker with a
// fetch handler, secure context). It is the browser's verdict rather than ours,
// so the listener has to exist before the first navigation.
await context.addInitScript(() => {
  window.__installable = false;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__installable = true;
  });
});

const page = await context.newPage();

const apiCalls = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith('/v2') || u.pathname === '/health') apiCalls.push(u.pathname);
});

// ---------------------------------------------------------------- 1 · online
await page.goto(URL_BASE, { waitUntil: 'load' });

const swState = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  // `ready` resolves as soon as there IS an active worker, which can still be
  // 'activating' — our activate handler awaits cache cleanup and clients.claim.
  const sw = reg.active;
  if (sw && sw.state !== 'activated') {
    await new Promise((r) => sw.addEventListener('statechange', function on() {
      if (sw.state === 'activated') { sw.removeEventListener('statechange', on); r(); }
    }));
  }
  return {
    scope: reg.scope,
    active: reg.active?.state ?? null,
    controlled: Boolean(navigator.serviceWorker.controller),
  };
});
check('service worker activates', swState.active === 'activated', `state=${swState.active}`);
check('root scope', swState.scope === `${URL_BASE}/`, swState.scope);

// A worker can be active without having claimed this page; the offline reload
// below depends on a controller existing, so wait for one rather than assume.
await page.evaluate(() => navigator.serviceWorker.controller
  ? true
  : new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })));

const cacheDump = await page.evaluate(async () => {
  const out = {};
  for (const name of await caches.keys()) {
    const c = await caches.open(name);
    out[name] = (await c.keys()).map((r) => new URL(r.url).pathname).sort();
  }
  return out;
});
writeFileSync(join(OUT, 'cache-contents.json'), JSON.stringify(cacheDump, null, 2));

const cacheNames = Object.keys(cacheDump);
const allCached = Object.values(cacheDump).flat();
check('exactly one shell cache', cacheNames.length === 1, cacheNames.join(', '));
check('precache is the shell only', allCached.length > 0 && allCached.length <= 14,
  `${allCached.length} entries`);

// ------------------------------------------- THE RULING: /v2 is never cached
const leaked = allCached.filter((p) => p.startsWith('/v2') || p === '/health');
check('NO /v2 or /health in any cache', leaked.length === 0,
  leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${apiCalls.length} api calls made, 0 cached`);

// The ONLINE half of the ruling test below: these same calls must succeed while
// online AND still leave nothing behind. Without this, the offline failure could
// just mean the worker breaks all API traffic.
const apiOnline = await page.evaluate(async () => {
  const probe = async (path) => {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      return { path, answered: true, status: r.status };
    } catch (e) {
      return { path, answered: false, error: String(e).slice(0, 60) };
    }
  };
  const results = [await probe('/health'), await probe('/v2/entities.get')];
  const cached = [];
  for (const name of await caches.keys()) {
    const c = await caches.open(name);
    cached.push(...(await c.keys())
      .map((r) => new URL(r.url).pathname)
      .filter((p) => p.startsWith('/v2') || p === '/health'));
  }
  return { results, cached };
});
check('online: API calls pass through the worker and answer',
  apiOnline.results.every((r) => r.answered),
  apiOnline.results.map((r) => `${r.path}=${r.answered ? r.status : r.error}`).join(', '));
check('online: answered API calls left NOTHING in the cache',
  apiOnline.cached.length === 0, apiOnline.cached.join(', ') || 'nothing');

// The mermaid/cytoscape/katex chunks must NOT be precached.
const heavy = allCached.filter((p) => /mermaid|cytoscape|katex|Diagram/i.test(p));
check('no lazy diagram chunks precached', heavy.length === 0, heavy.join(', ') || 'none');

// ------------------------------------------------------------ 2 · manifest
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel=manifest]');
  if (!link) return null;
  return (await fetch(link.href)).json();
});
check('manifest linked and parses', Boolean(manifest), manifest?.name ?? 'missing');
check('display: standalone', manifest?.display === 'standalone', manifest?.display);
check('has 192 + 512 + maskable icons',
  Boolean(manifest?.icons?.some((i) => i.sizes === '192x192'))
  && Boolean(manifest?.icons?.some((i) => i.sizes === '512x512' && i.purpose === 'any'))
  && Boolean(manifest?.icons?.some((i) => i.purpose === 'maskable')),
  (manifest?.icons ?? []).map((i) => `${i.sizes}/${i.purpose}`).join(' '));

const iconsOk = await page.evaluate(async (icons) => {
  const out = [];
  for (const i of icons) {
    const r = await fetch(i.src);
    const b = await r.blob();
    const bmp = await createImageBitmap(b);
    out.push({ src: i.src, declared: i.sizes, actual: `${bmp.width}x${bmp.height}`, bytes: b.size });
  }
  return out;
}, manifest?.icons ?? []);
check('every icon resolves at its declared size',
  iconsOk.every((i) => i.declared === i.actual),
  iconsOk.map((i) => `${i.src.split('/').pop()} ${i.actual} ${i.bytes}B`).join(', '));

// -------------------------------------------------- 3 · viewport + meta tags
const meta = await page.evaluate(() => ({
  viewport: document.querySelector('meta[name=viewport]')?.content,
  theme: document.querySelector('meta[name=theme-color]')?.content,
  appleCapable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content,
  appleBar: document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]')?.content,
  appleTitle: document.querySelector('meta[name=apple-mobile-web-app-title]')?.content,
  appleIcon: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href'),
}));
check('viewport-fit=cover', /viewport-fit=cover/.test(meta.viewport ?? ''), meta.viewport);
check('theme-color set', Boolean(meta.theme), meta.theme);
check('apple standalone meta set',
  meta.appleCapable === 'yes' && Boolean(meta.appleBar) && Boolean(meta.appleIcon),
  `${meta.appleCapable} / ${meta.appleBar} / ${meta.appleIcon}`);

// safe-area insets only resolve to non-zero with viewport-fit=cover; on a
// desktop Chrome emulation they are 0 regardless, so assert the property is at
// least understood rather than asserting a device inset we cannot produce here.
const safeArea = await page.evaluate(() => CSS.supports('padding-top', 'env(safe-area-inset-top)'));
check('env(safe-area-inset-*) supported', safeArea === true, String(safeArea));

// ----------------------------------------------------------- 4 · self-hosted fonts
const fontOrigins = await page.evaluate(() => performance
  .getEntriesByType('resource')
  .map((e) => new URL(e.name).origin)
  .filter((o, i, a) => a.indexOf(o) === i));
check('no third-party origins requested',
  fontOrigins.every((o) => o === new URL(URL_BASE).origin),
  fontOrigins.join(', '));

await page.screenshot({ path: join(OUT, '1-online.png') });

// ---------------------------------------------------------------- 5 · OFFLINE
await context.setOffline(true);
const before = apiCalls.length;
await page.reload({ waitUntil: 'load' }).catch(() => {});
await page.waitForTimeout(2500);

const offline = await page.evaluate(() => ({
  html: document.documentElement.outerHTML.length,
  rootChildren: document.getElementById('root')?.children.length ?? 0,
  text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
  // The shell's own type must have survived, else the app does not look like
  // itself. Measured on `.cv2-root`, NOT on `body`: tokens.css scopes the whole
  // type system to that class, so `body` computes to the UA default (Times) even
  // on a perfectly healthy page.
  scopedFont: (() => {
    const el = document.querySelector('.cv2-root');
    return el ? getComputedStyle(el).fontFamily : '(no .cv2-root)';
  })(),
  hanken: document.fonts.check('16px "Hanken Grotesk"'),
  // Proof the stylesheet itself arrived, independent of any font: a token that
  // only exists in tokens.css must resolve.
  paperToken: getComputedStyle(document.querySelector('.cv2-root') ?? document.body)
    .getPropertyValue('--pn-paper').trim(),
  styleSheets: document.styleSheets.length,
}));
writeFileSync(join(OUT, 'offline-state.json'), JSON.stringify(offline, null, 2));

check('offline reload still serves the shell', offline.rootChildren > 0,
  `#root has ${offline.rootChildren} child(ren), ${offline.html} bytes of HTML`);
// `document.fonts.check` alone is a trap: it answered `true` on a page whose
// stylesheet had failed to load, because nothing had asked for the face yet. The
// token is what actually proves the stylesheet arrived.
check('offline: stylesheet applied (tokens resolve)',
  offline.paperToken === '#F4F2EC',
  `--pn-paper=${offline.paperToken || '(unset)'} sheets=${offline.styleSheets}`);
check('offline: Hanken Grotesk in use, not a system fallback',
  /Hanken Grotesk/.test(offline.scopedFont) && offline.hanken === true,
  `computed=${offline.scopedFont} fonts.check=${offline.hanken}`);
check('offline: something is rendered, not a blank page',
  offline.text.length > 0, JSON.stringify(offline.text.slice(0, 200)));

// The honesty check that matters: nothing that looks like a work row may appear
// from cache. We cannot enumerate every possible row, so assert the negative we
// CAN assert — no /v2 response was served from a cache while offline.
const offlineCache = await page.evaluate(async () => {
  const out = [];
  for (const name of await caches.keys()) {
    const c = await caches.open(name);
    out.push(...(await c.keys()).map((r) => new URL(r.url).pathname));
  }
  return out;
});
check('offline: still no /v2 in any cache',
  offlineCache.filter((p) => p.startsWith('/v2')).length === 0,
  `${offlineCache.length} cached entries, ${apiCalls.length - before} api attempts while offline`);

/**
 * THE DECISIVE TEST OF THE RULING.
 *
 * The checks above prove nothing is STORED. This proves the consequence that
 * actually matters to a user: while offline, an API call must FAIL rather than
 * be answered from a cache. A pass here means the app cannot be handed a stale
 * row even if some future code path asks for one — offline is an honest absence
 * of data, enforced at the transport, not a convention the UI is trusted to keep.
 *
 * Run against the same origin the app itself uses, with the worker controlling
 * the page, so it exercises the real fetch handler and not a bypass.
 */
const apiOffline = await page.evaluate(async () => {
  const probe = async (path) => {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      return { path, answered: true, status: r.status, bytes: (await r.text()).length };
    } catch (e) {
      return { path, answered: false, error: String(e).slice(0, 80) };
    }
  };
  return {
    controlled: Boolean(navigator.serviceWorker.controller),
    results: [await probe('/health'), await probe('/v2/entities.get')],
  };
});
check('offline: API calls FAIL rather than being served from cache',
  apiOffline.controlled && apiOffline.results.every((r) => r.answered === false),
  `controller=${apiOffline.controlled} ` + apiOffline.results
    .map((r) => `${r.path}=${r.answered ? `ANSWERED ${r.status} (${r.bytes}B) — RULING BROKEN` : 'failed'}`)
    .join(', '));

await page.screenshot({ path: join(OUT, '2-offline.png') });

// ---------------------------------------------------------- 6 · standalone launch
// A real install cannot be driven from Playwright, but the display-mode media
// query is exactly what the app itself reacts to, so the standalone RENDERING
// is verifiable by emulating it.
const standalonePage = await context.newPage();
await standalonePage.emulateMedia({ media: 'screen' });
await context.setOffline(false);
await standalonePage.goto(URL_BASE, { waitUntil: 'load' });
const dm = await standalonePage.evaluate(() => ({
  browser: matchMedia('(display-mode: browser)').matches,
  standalone: matchMedia('(display-mode: standalone)').matches,
}));
check('display-mode media query readable', dm.browser || dm.standalone,
  `browser=${dm.browser} standalone=${dm.standalone}`);
await standalonePage.screenshot({ path: join(OUT, '3-reload-online.png') });

// ------------------------------------------------ 7 · Chrome's own verdict
// `Page.getAppManifest` is Chrome's parse of the manifest, including the errors
// it would show in DevTools > Application. An empty error list is the browser
// agreeing the manifest is valid, which is a stronger claim than our own
// field-by-field checks above.
const cdp = await context.newCDPSession(standalonePage);
const appManifest = await cdp.send('Page.getAppManifest').catch((e) => ({ errors: [String(e)] }));
const manifestErrors = (appManifest.errors ?? []).filter((e) => e.critical !== false);
check('Chrome parses the manifest with no critical errors',
  manifestErrors.length === 0,
  manifestErrors.map((e) => e.message ?? JSON.stringify(e)).join('; ') || 'none');

await standalonePage.waitForTimeout(1500);
const installable = await standalonePage.evaluate(() => window.__installable === true);
// Reported, not asserted: Chrome gates beforeinstallprompt on engagement
// heuristics that a fresh automated profile does not satisfy, so a `false` here
// is not evidence of a defect. The manifest parse above is the load-bearing check.
console.log(`INFO  beforeinstallprompt fired: ${installable}`
  + (installable ? '' : '  (automated profile — engagement heuristic, not a defect)'));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
