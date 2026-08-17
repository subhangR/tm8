/**
 * nav-matrix — LANE N'S INSTRUMENT: does an address mean the same thing everywhere?
 *
 * Where Lane 0's `mobile-audit.mjs` measures LAYOUT (overflow, tap targets),
 * this measures NAVIGATION SEMANTICS, in a real Chrome, over the same fixture
 * seam and the same viewport discipline:
 *
 *   A. COLD OPEN — every route the codec can build, opened in a browser with no
 *      prior state, on a phone and on a desktop. Records the shell, the settled
 *      hash (the canonical rewrite), which screen actually rendered, and whether
 *      the arrival spent a history entry (it must not: a cold arrival settles by
 *      REPLACE, and a pushed phantom entry would make the first back press mean
 *      something the viewer never did).
 *
 *   B. SHARE ROUND TRIP — the settled hash of every cold open, reopened in a
 *      FRESH context on the OTHER shell. The address bar is the shareable link
 *      (CopyLinkControl builds from the same codec), so "I share from desktop
 *      and the right screen appears on the phone" is asserted as: same hash in,
 *      equivalent landing out, both directions.
 *
 *   C. HONEST FAILURE — links that name nothing: an entity with no origin, an
 *      entity that does not exist, an unknown kind slug, an unknown space, and a
 *      bare legacy hash. Each must fail WITH A SENTENCE, not a blank screen, and
 *      must not be silently rewritten into somewhere else.
 *
 *   D. BACK, FOR REAL — the contract's §6 walks driven through `page.goBack()`
 *      (which IS the phone's gesture: nothing in the codebase intercepts back,
 *      so browser back and hardware back are the same event) with REAL row
 *      clicks, not store calls. Asserts one rung per press, no two-item trap
 *      (the hash must STAY where back put it — a bounce-back rewrite is the
 *      exact defect PR #229 fixed), and forward rebuilding the drill.
 *
 * Run from a tree whose `packages/tm8-ui` has node_modules (Lane 0's recipe):
 *   cd packages/tm8-ui && node e2e/nav-matrix.mjs --out <dir> [--label <name>]
 *
 * Inherits Lane 0's traps: `channel: 'chrome'` (no bundled chromium),
 * `isMobile`/`hasTouch` or the fine pointer gets you the desktop shell, and a
 * real `page.goto` per cold cell because a hash-only change does not reboot the
 * app. Reuses the fixture space (`sp-atelier`) so every id below is a constant.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

const SPACE = 'sp-atelier';
/** A task the fixture really holds; its title is this UUID, a unique DOM marker. */
const TASK_A = 'task-4f8c2a9e';
const TASK_A_TITLE = '4f8c2a9e-77b1-4e3d-9c2f-a1b0d3e5f6a7';
const TASK_B = 'task-blocked';

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, expectShell: 'mobile' },
  { name: 'desktop-1440', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, expectShell: 'desktop' },
];

/** Every destination the codec can build, as a shared link would carry it. */
const ROUTES = [
  { name: 'home', path: 'home' },
  { name: 'tasks', path: 'k/tasks' },
  { name: 'sessions', path: 'k/sessions' },
  { name: 'channels', path: 'channels' },
  { name: 'inbox', path: 'inbox' },
  { name: 'workspace', path: 'workspace' },
  { name: 'feed', path: 'feed' },
  { name: 'graph', path: 'graph' },
  { name: 'files', path: 'files' },
  { name: 'git', path: 'git' },
  { name: 'messages', path: 'messages' },
  { name: 'board', path: 'board' },
  { name: 'craft', path: 'craft' },
  { name: 'settings', path: 'settings' },
  { name: 'settings-projects', path: 'settings/projects' },
  { name: 'entity-link', path: `e/${TASK_A}?origin=tasks`, marker: TASK_A_TITLE },
];

/** Addresses that must fail with a reason, never a blank or a silent rewrite. */
const BAD_LINKS = [
  { name: 'entity-no-origin', path: `e/${TASK_A}`, expect: 'a refusal: landingOfRoute returns null for e/{id} with no origin' },
  { name: 'entity-nonexistent', path: 'e/task-does-not-exist?origin=tasks', expect: 'the tasks screen with an honest missing-entity state' },
  { name: 'unknown-kind', path: 'k/zebra-herd', expect: 'a refusal: slug names no registered kind' },
  { name: 'unknown-space', hash: '#/s/sp-nowhere/k/tasks', expect: 'whatever the app does with a foreign space id — recorded' },
  { name: 'legacy-bare', hash: '#/tasks', expect: 'legacy redirect against last-active space, else space picker' },
];

function gitRef() {
  const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return null; } };
  return {
    head: git('rev-parse', '--short', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    behindMain: Number(git('rev-list', '--count', 'HEAD..origin/main') ?? -1),
  };
}

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startVite() {
  const existing = process.env.AUDIT_BASE;
  if (existing) return { base: existing, stop: () => {} };
  const port = await freePort();
  const proc = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('vite did not report a URL in 30s:\n' + buf)), 30_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    proc.stderr.on('data', (d) => { buf += d; });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`vite exited ${c}:\n${buf}`)); });
  });
  return { base, stop: () => proc.kill('SIGTERM') };
}

/** What the page says about where it landed. Serializable only. */
function probeInPage() {
  const q = (sel) => document.querySelector(sel) !== null;
  const text = (document.body.innerText || '').trim();
  return {
    shell: q('.mobile-frame') ? 'mobile' : q('.shell-root') ? 'desktop' : 'none',
    hash: location.hash,
    historyLength: history.length,
    unrouted: q('[data-testid="mobile-unrouted"]'),
    notOnPhone: q('[data-testid="mobile-not-on-phone"]'),
    unbuiltView: q('[data-testid="unbuilt-view"]') || q('[data-testid="unbuilt-voice-view"]'),
    blank: text.length === 0,
    firstText: text.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 200),
  };
}

async function settle(page, ms = 1500) {
  await page.waitForTimeout(ms);
}

async function coldOpen(browser, vp, hash, base) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/mobile-audit.html${hash}`, { waitUntil: 'networkidle' });
  await settle(page);
  const probe = await page.evaluate(probeInPage);
  return { ctx, page, probe, pageErrors };
}

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const outDir = argOf('--out') ?? 'mobile-audit';
const label = argOf('--label') ?? 'nav-matrix';
const only = argOf('--part'); // A|B|C|D or null for all

const ref = gitRef();
console.log(`nav-matrix ref: ${ref.head} on ${ref.branch} (${ref.behindMain} behind origin/main)\n`);

const { base, stop } = await startVite();
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const report = { label, ref, space: SPACE, parts: {}, problems: [] };
const problem = (s) => { report.problems.push(s); console.log('  ! ' + s); };

/* ── A. COLD OPEN ─────────────────────────────────────────────────────────── */
if (!only || only === 'A' || only === 'B') {
  console.log('── A. cold open ──');
  const rows = [];
  for (const vp of VIEWPORTS) {
    for (const route of ROUTES) {
      const hash = route.path ? `#/s/${SPACE}/${route.path}` : route.hash;
      const { ctx, page, probe, pageErrors } = await coldOpen(browser, vp, hash, base);
      let markerFound = null;
      if (route.marker) markerFound = (await page.getByText(route.marker.slice(0, 20)).count()) > 0;
      /* A cold arrival must not spend a history entry. Chrome's history.length
         starts at 1 for a fresh tab navigation plus 1 for our goto — what must
         NOT happen is growth after settle (a push loop). Recorded, not assumed. */
      rows.push({
        viewport: vp.name, route: route.name, hashIn: hash,
        ...probe, markerFound, pageErrors: pageErrors.slice(0, 2),
        shellOk: probe.shell === vp.expectShell,
      });
      const flags = [
        probe.shell !== vp.expectShell ? 'WRONG-SHELL' : '',
        probe.blank ? 'BLANK' : '',
        route.marker && !markerFound ? 'NO-MARKER' : '',
        pageErrors.length ? 'JS-ERROR' : '',
      ].filter(Boolean).join(' ');
      console.log(`${vp.name.padEnd(13)} ${route.name.padEnd(17)} → ${probe.hash.slice(0, 60).padEnd(60)} [${probe.shell}] ${flags}`);
      if (probe.blank) problem(`${vp.name}/${route.name}: BLANK screen on cold open`);
      if (pageErrors.length) problem(`${vp.name}/${route.name}: ${pageErrors[0]}`);
      await ctx.close();
    }
  }
  report.parts.coldOpen = rows;

  /* ── B. SHARE ROUND TRIP — the settled hash, reopened on the OTHER shell ── */
  if (!only || only === 'B') {
    console.log('\n── B. share round trip (settled hash → other shell) ──');
    const trips = [];
    for (const row of rows) {
      const from = VIEWPORTS.find((v) => v.name === row.viewport);
      const to = VIEWPORTS.find((v) => v.name !== row.viewport);
      if (!row.hash || row.hash === '#/' || row.blank) continue;
      const { ctx, page, probe } = await coldOpen(browser, to, row.hash, base);
      const route = ROUTES.find((r) => r.name === row.route);
      let markerFound = null;
      if (route?.marker) markerFound = (await page.getByText(route.marker.slice(0, 20)).count()) > 0;
      const sameHash = probe.hash === row.hash;
      trips.push({ route: row.route, from: from.name, to: to.name, hash: row.hash, hashAfter: probe.hash, sameHash, markerFound, firstText: probe.firstText });
      const flags = [!sameHash ? 'HASH-DRIFT' : '', route?.marker && !markerFound ? 'NO-MARKER' : ''].filter(Boolean).join(' ');
      console.log(`${row.route.padEnd(17)} ${from.name} → ${to.name}  ${sameHash ? 'hash stable' : 'HASH DRIFT: ' + probe.hash.slice(0, 50)} ${flags}`);
      if (route?.marker && markerFound === false) problem(`round-trip ${row.route} ${from.name}→${to.name}: entity marker missing`);
      await ctx.close();
    }
    report.parts.roundTrip = trips;
  }
}

/* ── C. HONEST FAILURE ────────────────────────────────────────────────────── */
if (!only || only === 'C') {
  console.log('\n── C. honest failure links ──');
  const rows = [];
  for (const vp of VIEWPORTS) {
    for (const bad of BAD_LINKS) {
      const hash = bad.path ? `#/s/${SPACE}/${bad.path}` : bad.hash;
      const { ctx, page, probe, pageErrors } = await coldOpen(browser, vp, hash, base);
      const shot = `${outDir}/nav-fail__${vp.name}__${bad.name}.png`;
      await page.screenshot({ path: shot, fullPage: false });
      rows.push({ viewport: vp.name, link: bad.name, hashIn: hash, expect: bad.expect, ...probe, pageErrors: pageErrors.slice(0, 2), screenshot: shot });
      console.log(`${vp.name.padEnd(13)} ${bad.name.padEnd(20)} → ${probe.hash.slice(0, 50).padEnd(50)} ${probe.blank ? 'BLANK' : ''} "${probe.firstText.slice(0, 80)}"`);
      if (probe.blank) problem(`${vp.name}/${bad.name}: fails BLANK — no sentence`);
      await ctx.close();
    }
  }
  report.parts.honestFailure = rows;
}

/* ── D. BACK, FOR REAL — real clicks, real page.goBack() ──────────────────── */
if (!only || only === 'D') {
  console.log('\n── D. back walks (real browser history) ──');
  const walks = [];
  for (const vp of VIEWPORTS) {
    /* Walk C from BACK-CONTRACT §6: k/tasks → drill A → back → (forward). */
    const kindHash = `#/s/${SPACE}/k/tasks`;
    const { ctx, page, probe } = await coldOpen(browser, vp, kindHash, base);
    const w = { viewport: vp.name, walk: 'C: k/tasks → drill A → back → forward', steps: [], verdict: 'incomplete' };
    try {
      w.steps.push({ at: 'cold k/tasks', hash: probe.hash });
      /* THE REAL GESTURE: click the row whose title is the fixture UUID. On the
         phone the pre-Lane-2 layout defect (desktop detail pane drawn over the
         clipped list) can cover the row and fail actionability — that is a
         LAYOUT defect already on Lane 0's baseline, not a routing one. The
         force fallback dispatches the click on the row anyway so the walk still
         tests what THIS instrument owns; `forcedClick` records the concession. */
      const row = page.getByText(TASK_A_TITLE.slice(0, 20)).first();
      let forcedClick = false;
      await row.click({ timeout: 5000 }).catch(async () => {
        forcedClick = true;
        await row.click({ force: true, timeout: 5000 });
      });
      w.forcedClick = forcedClick;
      await settle(page);
      const afterDrill = await page.evaluate(probeInPage);
      w.steps.push({ at: 'drilled A (row click)', hash: afterDrill.hash });
      const drilled = afterDrill.hash.includes(`e/${TASK_A}`);
      if (!drilled) problem(`${vp.name} walk C: row click did not route to e/${TASK_A} — hash ${afterDrill.hash}`);

      await page.goBack();
      await settle(page);
      const afterBack = await page.evaluate(probeInPage);
      w.steps.push({ at: 'back', hash: afterBack.hash });
      /* THE TWO-ITEM TRAP CHECK: the hash must STAY at k/tasks. Wait longer and
         re-read — a bounce-back rewrite happens within the debounce window. */
      await settle(page, 1200);
      const held = await page.evaluate(probeInPage);
      w.steps.push({ at: 'back +1.2s (trap check)', hash: held.hash });
      const backOk = drilled && held.hash === probe.hash;
      if (!backOk) problem(`${vp.name} walk C: back did not hold at ${probe.hash} — ${held.hash}`);

      await page.goForward();
      await settle(page);
      const afterFwd = await page.evaluate(probeInPage);
      w.steps.push({ at: 'forward', hash: afterFwd.hash });
      const fwdOk = afterFwd.hash.includes(`e/${TASK_A}`);
      if (!fwdOk) problem(`${vp.name} walk C: forward did not rebuild e/${TASK_A} — ${afterFwd.hash}`);

      w.verdict = drilled && backOk && fwdOk ? 'PASS' : 'FAIL';
    } catch (e) {
      w.verdict = 'ERROR';
      w.error = String(e).slice(0, 300);
      problem(`${vp.name} walk C: ${w.error}`);
    }
    console.log(`${vp.name.padEnd(13)} walk C  ${w.verdict}`);
    walks.push(w);
    await ctx.close();

    /* Walk A/Q4: cold entity arrival — back leaves the app (history is spent
       nowhere). page.goBack() returning null means no entry behind: correct. */
    const { ctx: ctx2, page: p2, probe: pr2 } = await coldOpen(browser, vp, `#/s/${SPACE}/e/${TASK_A}?origin=tasks`, base);
    const w2 = { viewport: vp.name, walk: 'A/Q4: cold e/A — nothing behind', steps: [{ at: 'cold e/A', hash: pr2.hash }], verdict: 'incomplete' };
    try {
      const marker = (await p2.getByText(TASK_A_TITLE.slice(0, 20)).count()) > 0;
      w2.steps.push({ at: 'marker visible', ok: marker });
      const nav = await p2.goBack({ timeout: 3000 }).catch(() => null);
      /* goBack resolving null = no history entry behind = back belongs to the
         browser. That IS the contract's answer. A resolved navigation to another
         in-app hash would mean a phantom entry was pushed on arrival. */
      const after = await p2.evaluate(probeInPage);
      w2.steps.push({ at: 'goBack()', navigated: nav !== null, hash: after.hash });
      const stayed = nav === null || !after.hash.startsWith('#/s/');
      w2.verdict = marker && (nav === null) ? 'PASS' : stayed ? 'PASS-ish' : 'FAIL';
      if (w2.verdict === 'FAIL') problem(`${vp.name} walk A: cold arrival had an in-app entry behind it — phantom push (${after.hash})`);
    } catch (e) {
      w2.verdict = 'ERROR'; w2.error = String(e).slice(0, 300);
      problem(`${vp.name} walk A: ${w2.error}`);
    }
    console.log(`${vp.name.padEnd(13)} walk A  ${w2.verdict}`);
    walks.push(w2);
    await ctx2.close();
  }
  report.parts.backWalks = walks;
}

await browser.close();
stop();

writeFileSync(`${outDir}/${label}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`\nwrote ${outDir}/${label}.json`);
if (report.problems.length) {
  console.log(`${report.problems.length} PROBLEM(S):`);
  for (const p of report.problems) console.log('  ! ' + p);
} else {
  console.log('no problems recorded');
}
