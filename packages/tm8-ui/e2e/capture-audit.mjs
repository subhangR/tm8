/**
 * capture-audit.mjs — screenshot the running tm8-ui, for a human to look at.
 *
 * WHY FIREFOX AND NOT CHROMIUM. Chromium's renderer segfaults on this box, and
 * every launch variant fails identically: `--no-sandbox`, `--single-process`,
 * `--no-zygote`, swiftshader, and ASLR disabled via `setarch -R`. The fault is
 * a page fault with error code 0x27 inside V8 — the known Ubuntu 24.04 /
 * kernel 6.8 `vm.mmap_rnd_bits=32` incompatibility, which needs root to
 * change. Firefox has no V8 and sidesteps the class entirely. Please do not
 * spend another session re-deriving this.
 *
 * ROOTLESS SETUP THIS DEPENDS ON (already done on tm8-server):
 *   npx playwright install firefox
 *   # GTK3 closure into a private prefix, no sudo:
 *   apt-get download $(apt-cache depends --recurse --no-recommends --no-suggests \
 *     --no-conflicts --no-breaks --no-replaces --no-enhances libgtk-3-0t64 \
 *     libgdk-pixbuf-2.0-0 libcairo-gobject2 libpangocairo-1.0-0 libx11-xcb1 \
 *     libxcursor1 libxkbcommon0 libepoxy0 libwayland-client0 libwayland-cursor0 \
 *     libwayland-egl1 | grep '^\w' | sort -u)
 *   for d in *.deb; do dpkg-deb -x "$d" ~/.local/ff-libs/root; done
 *
 * RUN IT, from packages/tm8-ui (playwright resolves from the package):
 *   VITE_TM8_REAL_SEAM=0 npx vite --port 4612 --strictPort &
 *   FF=$HOME/.cache/ms-playwright/firefox-1509/firefox
 *   FR=$HOME/.local/ff-libs/root; R=$HOME/.local/pw-libs/root
 *   LD_LIBRARY_PATH="$FF:$FR/usr/lib/x86_64-linux-gnu:$FR/lib/x86_64-linux-gnu:$R/usr/lib/x86_64-linux-gnu" \
 *   FONTCONFIG_PATH=/etc/fonts SHOTS=/tmp/shots BASE=http://127.0.0.1:4612 \
 *   node e2e/capture-audit.mjs
 *
 * Firefox's own dir must come FIRST on LD_LIBRARY_PATH — it ships its own NSS,
 * and the pw-libs copy shadows it with an older soname if it wins.
 *
 * DO NOT set XDG_CACHE_HOME in that env: playwright resolves the browser
 * beneath it and will report the browser as missing.
 *
 * It drives the FIXTURE seam (`tm8-ui:real-seam=0`), so it neither reads nor
 * writes any live tm8 node, and the gate account is local PBKDF2 in a
 * throwaway profile.
 */
import { firefox } from '@playwright/test';

const OUT = process.env.SHOTS ?? '/tmp/shots';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4612';
const TAG = process.env.TAG ?? 'now';

const browser = await firefox.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try { localStorage.setItem('tm8-ui:real-seam', '0'); } catch { /* the gate handles blocked storage */ }
});
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e).slice(0, 200)}`));

const shot = async (name) => {
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${TAG}-${name}.png` });
  console.log(`[shot] ${TAG}-${name}.png`);
};

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForTimeout(3500);
await shot('01-gate');

// The gate's button text differs by branch — the local-account build says
// "Create owner account", the server-backed one "Create account". Match either
// rather than pinning to one and timing out on the other.
await page.getByLabel(/your name/i).fill('Design Review');
await page.getByLabel(/password/i).first().fill('design-review-pass');
await page.getByRole('button', { name: /create (owner )?account/i }).click();
await page.waitForTimeout(6000);
await shot('02-home');

/* The density figure this audit reports: sample the viewport on a 20px grid
   and count points landing on a leaf element that actually carries text.
   16% at 1440x900 as of 2026-08-05 — see the pixel audit. */
const density = await page.evaluate(() => {
  let filled = 0;
  let total = 0;
  for (let y = 0; y < innerHeight; y += 20) {
    for (let x = 0; x < innerWidth; x += 20) {
      total++;
      const el = document.elementFromPoint(x, y);
      if (el && el.children.length === 0 && (el.textContent ?? '').trim()) filled++;
    }
  }
  return { total, filled, pct: Math.round((filled / total) * 100) };
});
console.log('[density]', JSON.stringify(density));

/* The rail is the one that hid `Settings` below the fold with no affordance.
   Reported every run so a regression shows up without anyone remembering to
   go looking for it. */
const rail = await page.evaluate(() => {
  const s = document.querySelector('.shell-rail__scroll');
  if (!s) return { found: false };
  const bottom = s.getBoundingClientRect().bottom;
  return {
    found: true,
    hiddenPx: s.scrollHeight - s.clientHeight,
    belowFold: Array.from(s.querySelectorAll('.shell-rail__row, .shell-rail__leaf'))
      .filter((r) => r.getBoundingClientRect().top > bottom - 8)
      .map((r) => (r.textContent ?? '').trim().slice(0, 24)),
  };
});
console.log('[rail]', JSON.stringify(rail));

for (const theme of ['dark', 'light']) {
  await page.evaluate((t) => {
    (document.querySelector('.cv2-root') ?? document.documentElement).setAttribute('data-theme', t);
  }, theme);
  await shot(`03-home-${theme}`);
}

await page.setViewportSize({ width: 1024, height: 768 });
await shot('04-narrow-1024');

console.log('[errors]', errors.length ? errors.slice(0, 12).join('\n') : '(none)');
await browser.close();
