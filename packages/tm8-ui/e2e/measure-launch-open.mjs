/**
 * HOW LONG THE LAUNCH CARD TAKES TO OPEN, measured in a real browser against
 * a real node (lane E of "Tm8 Session Launch Improvements").
 *
 * From the Run press (t0 = the click, `performance.now()` in the page) to:
 *   paint    — the first frame drawn with the card and its Launch button;
 *   enabled  — Launch stops refusing for good (the last flip to enabled
 *              inside the window; a flip back counts against it);
 *   strip    — the strip's groups stop changing (the last change inside
 *              the window: a "loading → rows" or "cached → confirmed" swap);
 * plus every refusal Launch showed on the way and every request the open
 * fired, with its duration. Jev is never asked by opening, so it does not
 * appear here; its latency is a node fact (`jev_calls.latency_ms`).
 *
 * Three opens per run: COLD (a fresh browser profile), WARM (the same page
 * again) and RELOAD (the page reloaded, storage kept). Runs alternate between
 * the UIs named on the command line so machine load drifts onto all of them
 * alike; the report is the median and p90 per UI and open.
 *
 * Usage:
 *   node e2e/measure-launch-open.mjs <spaceId> <subjectId> <label>=<origin> [<label>=<origin>…] [--runs 8] [--auth state.json]
 * The origins are UI servers (`vite preview`) proxying a dev-slot node — never
 * production. `--auth` is a Playwright storage state of a signed-in viewer:
 * every fresh profile gets its session cookie and `tm8ui.auth.*` keys, and
 * nothing else, so COLD really is cold. The headless-browser kit at
 * /home/tm8/prod-data/tools/browser is used when present (this node's
 * Chromium needs its pkey shim).
 */
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : fallback;
};
const RUNS = Number(flag('--runs', '8'));
const AUTH = flag('--auth', null);
const auth = AUTH ? JSON.parse(readFileSync(AUTH, 'utf8')) : null;
/** The signed-in viewer's session for one UI origin: the cookie, and the auth keys copied onto that origin. */
const sessionFor = (origin) => (auth ? {
  cookies: auth.cookies,
  origins: [{ origin, localStorage: auth.origins.flatMap((o) => o.localStorage).filter((item) => item.name.startsWith('tm8ui.auth.')) }],
} : undefined);
const [spaceId, subjectId, ...targets] = args;
const uis = targets.map((t) => { const at = t.indexOf('='); return { label: t.slice(0, at), origin: t.slice(at + 1) }; });
if (!spaceId || !subjectId || uis.length === 0) {
  console.error('usage: node e2e/measure-launch-open.mjs <spaceId> <subjectId> <label>=<origin>… [--runs 8] [--auth state.json]');
  process.exit(2);
}
if (uis.some((u) => /:(7777|17777)\b/.test(u.origin))) {
  console.error('Refusing a production origin (7777/17777): measure a dev slot.');
  process.exit(2);
}

const KIT = '/home/tm8/prod-data/tools/browser/launch.json';
const kit = existsSync(KIT) ? JSON.parse(readFileSync(KIT, 'utf8')) : null;
const { chromium } = kit ? await import(`${kit.playwright}/index.mjs`) : await import('@playwright/test');
const browser = await chromium.launch({
  ...(kit ? { executablePath: kit.executablePath, env: { ...process.env, ...kit.env }, args: kit.args } : {}),
});

/** How long one open is watched after the press. Anything still changing after this is reported as "> WINDOW". */
const WINDOW_MS = 8000;

/* Installed in the page before the press: watches the card and records when
   each milestone happened, relative to the press. */
const WATCH = (windowMs) => {
  const m = { t0: 0, paint: null, enabled: null, enabledFlips: 0, strip: null, stripChanges: 0, refusals: [], done: false };
  window.__launchOpen = m;
  let lastStrip = '';
  let wasEnabled = false;
  const check = () => {
    if (!m.t0) return;
    const now = performance.now() - m.t0;
    const card = document.querySelector('[data-testid="launch-card"]');
    const send = card?.querySelector('[data-testid="nsx-send"]');
    if (send && m.paint === null) {
      m.paint = -1;
      requestAnimationFrame(() => setTimeout(() => { m.paint = performance.now() - m.t0; }, 0));
    }
    if (send) {
      const enabled = send.getAttribute('aria-disabled') !== 'true';
      if (!enabled) {
        const why = send.getAttribute('title') ?? '';
        if (!m.refusals.some((r) => r.why === why)) m.refusals.push({ at: Math.round(now), why });
      }
      if (enabled && !wasEnabled) { m.enabled = now; m.enabledFlips += 1; }
      if (!enabled && wasEnabled) m.enabled = null;
      wasEnabled = enabled;
    }
    const strip = card?.querySelector('[data-testid="lcd3-strip"]');
    if (strip) {
      const shape = [...strip.querySelectorAll('[data-testid^="lcd3-group-"]')].map((g) => g.textContent).join('|')
        + `#${strip.querySelector('[data-testid="lcd3-strip-empty"]')?.textContent ?? ''}`;
      if (shape !== lastStrip) { lastStrip = shape; m.stripChanges += 1; m.strip = now; }
    }
  };
  new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__launchOpenStart = () => { m.t0 = performance.now(); check(); setTimeout(() => { m.done = true; }, windowMs); };
};

async function openOnce(page) {
  await page.evaluate(WATCH, WINDOW_MS);
  const requests = [];
  const onDone = (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/v2/')) return;
    const t = req.timing();
    requests.push({ path: url.pathname.replace(/[0-9a-f-]{36}/g, ':id'), ms: Math.round(t.responseEnd) });
  };
  page.on('requestfinished', onDone);
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="panel-primary-run"]');
    window.__launchOpenStart();
    button.click();
  });
  await page.waitForFunction(() => window.__launchOpen.done, null, { timeout: WINDOW_MS + 10000 });
  page.off('requestfinished', onDone);
  const m = await page.evaluate(() => window.__launchOpen);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="launch-card"]', { state: 'detached', timeout: 10000 }).catch(() => {});
  return { paint: m.paint, enabled: m.enabled, strip: m.strip, stripChanges: m.stripChanges, refusals: m.refusals, requests };
}

/** Load the subject's page and wait for its Run verb; a first-run welcome dialog is put off ("Later"). */
async function arrive(page) {
  const run = page.locator('[data-testid="panel-primary-run"]').first();
  const later = page.getByRole('button', { name: 'Later' });
  await Promise.race([run.waitFor({ state: 'visible', timeout: 120000 }), later.waitFor({ state: 'visible', timeout: 120000 })]);
  if (await later.isVisible()) await later.click();
  await run.waitFor({ state: 'visible', timeout: 120000 });
  /* Let boot's reads settle before the press, so the open is measured, not boot. */
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

async function measure(ui) {
  const session = sessionFor(ui.origin);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(session ? { storageState: session } : {}) });
  const page = await context.newPage();
  await page.goto(`${ui.origin}/#/s/${spaceId}/e/${subjectId}`);
  await arrive(page);
  const cold = await openOnce(page);
  const warm = await openOnce(page);
  await page.reload();
  await arrive(page);
  const reload = await openOnce(page);
  await context.close();
  return { cold, warm, reload };
}

const results = Object.fromEntries(uis.map((u) => [u.label, { cold: [], warm: [], reload: [] }]));
for (let run = 0; run < RUNS; run += 1) {
  for (const ui of run % 2 === 0 ? uis : [...uis].reverse()) {
    const r = await measure(ui);
    for (const open of ['cold', 'warm', 'reload']) results[ui.label][open].push(r[open]);
    process.stderr.write(`run ${run + 1}/${RUNS} ${ui.label}: cold enabled ${fmt(r.cold.enabled)} strip ${fmt(r.cold.strip)} · warm strip ${fmt(r.warm.strip)} · reload strip ${fmt(r.reload.strip)}\n`);
  }
}
await browser.close();

function fmt(ms) { return ms === null || ms === undefined ? `>${WINDOW_MS}` : `${Math.round(ms)}`; }
function quantile(values, q) {
  const known = values.map((v) => (v === null || v < 0 ? Infinity : v)).sort((a, b) => a - b);
  const v = known[Math.min(known.length - 1, Math.floor(q * (known.length - 1) + 0.5))];
  return v === Infinity ? `>${WINDOW_MS}` : `${Math.round(v)}`;
}

console.log(`\nLaunch card open, ms from the Run press (median / p90 over ${RUNS} runs)\n`);
console.log('ui        open     paint        enabled      strip        strip swaps  requests fired on open');
for (const ui of uis) {
  for (const open of ['cold', 'warm', 'reload']) {
    const rows = results[ui.label][open];
    const col = (key) => `${quantile(rows.map((r) => r[key]), 0.5)} / ${quantile(rows.map((r) => r[key]), 0.9)}`.padEnd(13);
    const fired = {};
    for (const r of rows) for (const q of r.requests) (fired[q.path] ??= []).push(q.ms);
    const reqs = Object.entries(fired)
      .map(([path, ms]) => `${path.replace('/v2/spaces/:id', '')} ×${(ms.length / rows.length).toFixed(1)} ~${quantile(ms, 0.5)}ms`)
      .join(', ');
    const swaps = rows.map((r) => r.stripChanges).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    console.log(`${ui.label.padEnd(10)}${open.padEnd(9)}${col('paint')}${col('enabled')}${col('strip')}${String(swaps).padEnd(13)}${reqs}`);
  }
}
const refusals = new Map();
for (const ui of uis) for (const open of ['cold', 'warm', 'reload']) for (const r of results[ui.label][open]) {
  for (const f of r.refusals) refusals.set(`${ui.label} ${open}: ${f.why}`, (refusals.get(`${ui.label} ${open}: ${f.why}`) ?? 0) + 1);
}
console.log('\nRefusals Launch showed before it enabled (count of opens):');
for (const [why, n] of refusals) console.log(`  ${n}× ${why}`);
console.log(JSON.stringify({ raw: results }));
