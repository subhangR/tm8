# Pixel verification — OWED for D73/D74

Status: **NOT DONE.** Written 2026-08-05, at the moment the gate was found blocked.

D73 (the Obsidian & Brass palette) and D74 (three undefined-token fixes) shipped
on static evidence only. This file lists exactly what was never looked at, so
the gap stays a known gap instead of decaying into an assumed pass.

## Why it is owed

No browser on this host can start:

- Playwright's cached Firefox 1509 → `libgtk-3.so.0: cannot open shared object file`
- Playwright's cached Chromium 1208 → `libatk-1.0.so.0: cannot open shared object file`
- `sudo` requires a password, so the libraries cannot be installed from a session
- `playwright.config.ts` pins `channel: 'chrome'`, which needs a **system** Chrome
  that is not installed — the e2e suite would not run as configured even after
  the libraries land

## Unblock

```sh
sudo apt-get install -y libgtk-3-0 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64
# or, equivalently:
sudo ./node_modules/.bin/playwright install-deps
```

Then, because of the `channel: 'chrome'` pin, either install a system Chrome
(`npx playwright install chrome`) or drop the pin so the bundled Chromium is used.

The dev server needs a backend to render from a real node rather than fallbacks:
`vite.config.ts` proxies `/v2` to `127.0.0.1:4610` (override with
`TM8_SERVER_ORIGIN`). Nothing listened on 4610 during this build — the live
servers were 7777, 8888 and 17777. **Point it at a real server before judging any
screen, or you are verifying fixtures.**

## What was verified WITHOUT pixels

Do not redo these; they are green and recorded.

- Full suite: 117 files, 1790 passed, 1 skipped
- `tsc --noEmit` clean
- Production build clean
- Contrast measured arithmetically for every text/background pair in both themes
- Bundle inspection: new palette present in `dist/assets/index-*.css`; Atelier
  values (`#1D1912`, `#B26A2B`, `#F4F2EC`, `#23201B`) all absent
- Static audit: zero undefined `var(--pn-*)` references package-wide

None of that can see layout. That is the entire point of the list below.

## The owed checks

Drive each at **375 / 768 / 1024 / 1440**, in **both themes**.

### 1. The nested-scope hazard — highest risk, check first
`.cv2-root` is both the theme scope and the `zoom: 1.1` scale hook, and it is
re-opened inside itself (`EntityDetailPanel`, AlwaysDark terminal host). A
`.cv2-root .cv2-root { zoom: 1 }` reset exists and is believed correct, but this
package has already shipped a 1.21x (1.1²) terminal for weeks behind a
counter-scale that looked right in isolation.

- [ ] Measure a work_session panel's computed scale against an ordinary panel — equal, not 1.21x
- [ ] Measure xterm glyphs at a physical 13px
- [ ] Walk the WHOLE ancestor chain. Never read one value and conclude.

### 2. The inset top highlight (`--pn-edge-hi`)
Baked into `--pn-sh-md/-hover/-pop`, so it reaches every consumer at once —
including elements that previously had no inset shadow and were never designed
for one.

- [ ] Raised cards read milled, not haloed
- [ ] No bright hairline across the top of anything with `overflow: hidden`, a
      clipped child, or its own inner border
- [ ] Dark mode: the 0.055 alpha is present but not a visible light strip
- [ ] Check the graph minimap, entity tree, files board, authboard specimen —
      the `--pn-sh-md` consumers found by grep

### 3. Serif on `.t-title` — the largest behavioural type change
Entity titles moved from Hanken Grotesk to Newsreader at 15.5px.

- [ ] Titles do not overflow or wrap where the sans fitted (serif sets wider)
- [ ] List rows, task tiles and panel headers keep their vertical rhythm
- [ ] Newsreader is actually loading — if it falls back to Georgia the metrics
      shift again. Confirm via computed style, not by eye.
- [ ] `text-wrap: balance` on `.t-display`/`.t-h1` has no unintended raggedness

### 4. The three D74 fixes — confirm they actually render
- [ ] `.gv-lens` segmented control (graph): filled recessed track, not a hollow outline
- [ ] `panels.css` 10px/9.5px uppercase mono labels: visible letter-spacing
- [ ] `.lq__more:hover` and the refusal block: correct ink, unchanged from before

### 5. Contrast, in situ
Arithmetic proves the token pairs. It does not prove which pairs actually meet.

- [ ] Run axe-core (already a dependency) per screen, both themes
- [ ] Hunt for any place `--pn-ink-4` carries TEXT — it is 2.05:1/2.37:1 and
      decorative-only by ruling. Arithmetic cannot find these; rendering can.
- [ ] Status chips: confirm colour + word, and that the word is legible on `-soft`

### 6. The global accessibility baseline (new in app.css)
- [ ] Tab through every screen: focus ring visible on every control, nothing trapped
- [ ] The 2px brass ring is visible against BOTH grounds, including on `--pn-sunk`
- [ ] It does not double up with the 34 pre-existing bespoke `:focus-visible` rules
- [ ] With `prefers-reduced-motion: reduce`, no transitions run AND nothing hangs
      waiting on a `transitionend`/`animationend` that no longer fires

### 7. Screens to cover
home · tasks · inbox · channel · docs · graph · projects · files · prompts ·
servers · settings (space + governance) · account · attention · authoring ·
the workspace three-panel view · the terminal host.

---

Close this file by deleting it and adding a DECISIONS entry recording what the
pixels showed — including anything they contradicted.
