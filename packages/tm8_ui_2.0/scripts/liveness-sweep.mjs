#!/usr/bin/env node
/**
 * THE LIVENESS SWEEP — does every control actually do something?
 *
 * WHY. `New session` shipped dead and stayed dead across several deploys. It
 * rendered enabled, it was covered by tests, and the tests passed — because a
 * test can assert a button exists and a handler is wired without ever asking
 * whether pressing it changes anything. The one that found it was a person
 * clicking it. This does that at scale.
 *
 * WHAT "WORKS" MEANS HERE: pressing a control produces an OBSERVABLE change —
 * the address changes, a region mounts or unmounts, the DOM grows or shrinks
 * meaningfully, or a refusal appears SAYING WHY. That last one counts as
 * working: a disabled control with a stated reason is honest. A control that
 * produces nothing at all is not.
 *
 * SAFETY — THIS RUNS AGAINST PRODUCTION WITH REAL DATA.
 * Destructive verbs are never pressed. The denylist below is matched against
 * a control's accessible name, and anything that matches is REPORTED AS
 * UNTESTED rather than clicked. Being unable to prove a delete button works is
 * the correct outcome; deleting somebody's work to prove it is not. A control
 * whose name cannot be read is also skipped rather than guessed at.
 *
 * Every click runs in a FRESH context on a FRESH page load, so one control
 * cannot poison the next, and an accidental state change cannot cascade.
 *
 * USAGE
 *   TM8_AGENT_TOKEN=… node scripts/liveness-sweep.mjs [--limit 12] [--route home]
 * Firefox only; see scripts/render-gate.mjs for the LD_LIBRARY_PATH it needs.
 * EXIT  0 nothing dead · 1 dead controls found · 2 could not run
 */
import { firefox } from '/home/tm8/prod-workspace/tm8/node_modules/.bun/node_modules/playwright-core/index.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const ORIGIN = arg('origin', 'https://tm8.sh');
const SPACE = arg('space', '019fbd5a-3c5b-71ea-9b91-1d3baa50da25');
const LIMIT = Number(arg('limit', '14'));
const ONLY = arg('route', null);
const TOKEN = process.env.TM8_AGENT_TOKEN;
if (!TOKEN) { console.error('liveness-sweep: no TM8_AGENT_TOKEN'); process.exit(2); }

/* NEVER PRESSED. Matched case-insensitively against the accessible name. */
const DESTRUCTIVE = /delete|remove|archive|terminate|cancel|discard|revoke|sign out|log out|leave|reset|clear|rollback|force|purge|drop|unlink|disconnect|kill|stop|abort|merge|close|publish|deploy|send|submit|invite|pay|upgrade|downgrade/i;

const ROUTES = [
  ['home', `#/s/${SPACE}/home`],
  ['tasks', `#/s/${SPACE}/home/k/tasks`],
  ['sessions', `#/s/${SPACE}/home/k/work_sessions`],
  ['docs', `#/s/${SPACE}/home/k/docs`],
  ['projects', `#/s/${SPACE}/home/k/projects`],
  ['board', `#/s/${SPACE}/board-v2`],
  ['graph', `#/s/${SPACE}/graph`],
  ['settings', `#/s/${SPACE}/settings`],
  ['work', `#/s/${SPACE}/work`],
  ['craft', `#/s/${SPACE}/craft`],
  ['help', `#/s/${SPACE}/help`],
].filter(([n]) => !ONLY || n === ONLY);

const browser = await firefox.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/firefox-1509/firefox/firefox`,
  headless: true,
});

async function open(hash) {
  const ctx = await browser.newContext({
    viewport: { width: 1512, height: 950 }, ignoreHTTPSErrors: true,
    serviceWorkers: 'block', colorScheme: 'light',
  });
  await ctx.addInitScript((t) => {
    const sessionId = t.slice('tm8s_'.length).split('.')[0];
    localStorage.setItem('tm8ui.auth.passes.v1', JSON.stringify({ [location.origin]: { token: t, sessionId,
      expiresAt: '2026-12-31T00:00:00.000+00:00', signedInAt: '2026-08-29T20:08:08.128+00:00',
      account: { handle: 'tarkesh', displayName: 'Tharak', accountId: '019fd18d-19de-7c65-9a23-657b9926b186',
        identityId: 'id_fa66226d-f157-4f51-b5ad-77ec0c359879', isOwner: false, isNodeAdmin: true } } }));
  }, TOKEN);
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
  return { ctx, page };
}

const snapshot = (page) => page.evaluate(() => ({
  url: location.hash,
  count: document.querySelectorAll('*').length,
  text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
  regions: [...document.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('testid') || n.dataset.testid).sort().join('|').slice(0, 900),
}));

const report = [];
for (const [name, hash] of ROUTES) {
  const first = await open(hash);
  const dead0 = await first.page.evaluate(() => (document.querySelectorAll('*').length < 60 ? 'empty' : null));
  if (dead0) { console.error(`✗ ${name}: route did not render (${dead0})`); report.push({ route: name, control: '(route)', verdict: 'ROUTE DEAD' }); await first.ctx.close(); continue; }

  /* Enumerate by accessible name, then re-find by name on a fresh page for
     each press — an index into a live list goes stale the moment anything
     re-renders, and pressing the wrong control is worse than skipping one. */
  const controls = await first.page.evaluate(() => {
    const seen = new Set();
    return [...document.querySelectorAll('button, [role="button"], a[href]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; })
      .map((el) => ({
        label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        reason: (el.getAttribute('title') || '').slice(0, 80),
      }))
      .filter((c) => c.label && !seen.has(c.label) && seen.add(c.label));
  });
  await first.ctx.close();

  console.log(`\n── ${name}: ${controls.length} named controls`);
  let n = 0;
  for (const c of controls) {
    if (n >= LIMIT) { report.push({ route: name, control: `(+${controls.length - n} not reached)`, verdict: 'UNTESTED' }); break; }
    if (DESTRUCTIVE.test(c.label)) { report.push({ route: name, control: c.label, verdict: 'SKIPPED destructive' }); continue; }
    if (c.disabled) { report.push({ route: name, control: c.label, verdict: c.reason ? 'DISABLED with a reason' : 'DISABLED, NO REASON' }); continue; }
    n += 1;
    const { ctx, page } = await open(hash);
    const before = await snapshot(page);
    let err = null;
    try {
      const target = page.getByRole('button', { name: c.label, exact: true }).first();
      if (await target.count()) await target.click({ timeout: 4000 });
      else { const alt = page.getByText(c.label, { exact: true }).first(); if (await alt.count()) await alt.click({ timeout: 4000 }); else err = 'could not re-find'; }
    } catch (e) { err = String(e).split('\n')[0].slice(0, 70); }
    await page.waitForTimeout(2600);
    const after = await snapshot(page);
    const changed = before.url !== after.url || Math.abs(after.count - before.count) > 3
      || before.regions !== after.regions || before.text !== after.text;
    const verdict = err ? `SKIPPED (${err})` : changed ? 'works' : 'NOTHING HAPPENS';
    if (verdict !== 'works') report.push({ route: name, control: c.label, verdict });
    console.log(`   ${verdict === 'works' ? '✓' : '✗'} ${c.label} — ${verdict}`);
    await ctx.close();
  }
}
await browser.close();

const dead = report.filter((r) => r.verdict === 'NOTHING HAPPENS' || r.verdict === 'DISABLED, NO REASON' || r.verdict === 'ROUTE DEAD');
console.log(`\n=== ${dead.length} dead control(s) ===`);
for (const d of dead) console.log(`  ${d.route.padEnd(10)} ${d.control.padEnd(44)} ${d.verdict}`);
const other = report.filter((r) => !dead.includes(r));
console.log(`\n(${other.length} skipped: ${[...new Set(other.map((o) => o.verdict))].join(', ')})`);
process.exit(dead.length ? 1 : 0);
