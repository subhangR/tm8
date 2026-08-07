# tm8 UI — "Aurora Glass" redesign spec (AUTHORITATIVE)

This document is the single source of truth for the full UI redesign. Every agent
building any part of the UI MUST read this first and build to it exactly. The goal:
a vivid, premium, frosted-glass + gradient platform that feels like nothing else,
while staying fully readable in dense views (task boards, terminals, threads).

## 0. Non-negotiable rules

1. **Token-first, always.** Never write a raw color/size in a component CSS file.
   Style only through `--pn-*` / `--cv2-*` / `--grad-*` / `--glass-*` tokens defined in
   `tokens.css`. Existing `var(--pn-x, #fallback)` fallbacks may stay.
2. **Never delete an existing token name.** `tokens.css` is a *superset* of the old set —
   every old `--pn-*` name keeps existing (with new values) so nothing breaks.
3. **Class names are frozen.** Keep every `cv2-*` / existing class name. This is a
   restyle + functional vetting pass, NOT a markup rewrite. Change CSS values and add
   glass/gradient layers; do not rename classes or restructure the DOM unless a control
   is broken.
4. **Status is color + word, never color alone.** Keep every status label text.
5. **Ownership:** foundation owns `tokens.css`, `kit/kit.css`, `shell/shell.css`. Every
   other agent edits ONLY files inside its assigned directory and must NOT touch those
   three shared files. If you need a new shared token, list it in your report; do not add it.

## 1. Aesthetic

**Aurora Glass.** A soft aurora gradient canvas (indigo / violet / magenta blooms)
sits behind frosted, translucent panels. Interactive accents use a vivid brand
gradient; active/primary states glow. Dark is the hero theme; light is a frosted-white
variant of the same system. Motion is quick and smooth with a subtle spring on
expressive accents (never on dense list items).

- **Big containers become translucent** so the aurora canvas shows through the glass.
  Panels/cards use `--pn-card` (already translucent) + `backdrop-filter: blur(var(--glass-blur))`.
- **Primary buttons** get the brand gradient (`--grad-brand`) + `--glow-brand` on hover.
- **Active nav / selected** states get a gradient marker/underline + soft glow.
- Use blur on structural surfaces (rails, panels, popovers, headers), NOT on every tiny
  tile — keep dense lists cheap to paint.

## 2. AUTHORITATIVE `tokens.css`

Foundation agent: replace `packages/ui/src/collab-v2/tokens.css` with EXACTLY this
(you may reflow comments, but keep every token name and value):

```css
/* ==========================================================================
   tm8 — "AURORA GLASS" design tokens. Module-scoped under .cv2-root.
   Frosted glass + vivid gradient. Dark = hero via [data-theme="dark"].
   Status is ALWAYS color + word, never color alone.
   ========================================================================== */
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

.cv2-root {
  /* --- 1 · surfaces (LIGHT = frosted white over soft aurora) --------------- */
  --pn-paper:    #EEF0F8;
  --pn-surface:  rgba(255,255,255,0.66);
  --pn-card:     rgba(255,255,255,0.74);
  --pn-hover:    rgba(109,94,252,0.06);
  --pn-active:   rgba(109,94,252,0.11);

  --pn-line:     rgba(23,23,54,0.10);
  --pn-line-2:   rgba(23,23,54,0.17);

  --pn-ink:      #131427;
  --pn-ink-2:    #454763;
  --pn-ink-3:    #6D6F90;
  --pn-ink-4:    #A2A4C1;

  --pn-wash:     var(--pn-surface);
  --pn-muted:    var(--pn-ink-3);

  /* aurora canvas (applied on .cv2-root) */
  --pn-aurora:
    radial-gradient(60% 55% at 12% 6%,  rgba(99,91,255,0.22), transparent 60%),
    radial-gradient(55% 50% at 92% 12%, rgba(255,77,157,0.16), transparent 60%),
    radial-gradient(60% 60% at 78% 96%, rgba(11,165,236,0.16), transparent 62%);

  /* --- 2 · brand (vivid indigo→violet) + gradients ------------------------ */
  --pn-brand:      #6D5EFC;
  --pn-brand-2:    #5A49E0;
  --pn-brand-soft: rgba(109,94,252,0.12);
  --pn-brand-rgb:  109, 94, 252;

  --grad-brand:      linear-gradient(135deg,#635BFF 0%,#B14BFF 52%,#FF4D9D 100%);
  --grad-brand-soft: linear-gradient(135deg, rgba(99,91,255,0.16), rgba(255,77,157,0.14));
  --grad-text:       linear-gradient(120deg,#635BFF,#B14BFF 55%,#FF4D9D);
  --glow-brand:      0 0 0 1px rgba(109,94,252,0.35), 0 10px 30px rgba(109,94,252,0.28);
  --glow-brand-sm:   0 0 0 1px rgba(109,94,252,0.30), 0 4px 14px rgba(109,94,252,0.22);

  /* --- 3 · glass recipe --------------------------------------------------- */
  --glass-blur:        16px;
  --glass-blur-strong: 26px;
  --glass-bg:          var(--pn-card);
  --glass-border:      var(--pn-line);
  --glass-highlight:   inset 0 1px 0 rgba(255,255,255,0.55);

  /* --- 4 · status (vivid, semantic) --------------------------------------- */
  --pn-run:   #12B76A;  --pn-run-soft:   rgba(18,183,106,0.12);
  --pn-wait:  #F59E0B;  --pn-wait-soft:  rgba(245,158,11,0.14);
  --pn-block: #F63D68;  --pn-block-soft: rgba(246,61,104,0.12);
  --pn-info:  #0BA5EC;  --pn-info-soft:  rgba(11,165,236,0.12);
  --pn-idle:  #8B8FA8;  --pn-idle-soft:  rgba(139,143,168,0.16);

  --cv2-status-working: var(--pn-run);  --cv2-status-working-soft: var(--pn-run-soft);
  --cv2-status-done:    var(--pn-run);  --cv2-status-done-soft:    var(--pn-run-soft);
  --cv2-status-blocked: var(--pn-block);--cv2-status-blocked-soft: var(--pn-block-soft);
  --cv2-status-review:  var(--pn-info); --cv2-status-review-soft:  var(--pn-info-soft);
  --cv2-status-stale:   var(--pn-wait); --cv2-status-stale-soft:   var(--pn-wait-soft);
  --cv2-status-idle:    var(--pn-idle); --cv2-status-idle-soft:    var(--pn-idle-soft);

  /* --- 5 · type ----------------------------------------------------------- */
  --pn-serif: 'Space Grotesk', system-ui, sans-serif;      /* display headings */
  --pn-ui:    'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --pn-mono:  'JetBrains Mono', ui-monospace, 'SF Mono', 'Menlo', monospace;

  --pn-fs-display: 40px; --pn-fs-h1: 28px; --pn-fs-h2: 22px; --pn-fs-h3: 18px;
  --pn-fs-title: 15px; --pn-fs-body: 14px; --pn-fs-sm: 13px; --pn-fs-label: 12px;
  --pn-fs-micro: 11px; --pn-fs-mono: 12.5px;

  --pn-lh-tight: 1.16; --pn-lh-snug: 1.34; --pn-lh-body: 1.5;
  --pn-track-mega: 0.14em; --pn-track-label: 0.05em; --pn-track-tight: -0.015em;

  /* --- 6 · spacing (4px grid) --------------------------------------------- */
  --pn-space-1: 4px;  --pn-space-2: 8px;  --pn-space-3: 12px; --pn-space-4: 16px;
  --pn-space-5: 20px; --pn-space-6: 24px; --pn-space-8: 32px; --pn-space-10: 40px;
  --pn-space-12: 48px; --pn-space-16: 64px;

  /* --- 7 · radii (softened for glass) ------------------------------------- */
  --pn-r-xs: 6px; --pn-r-sm: 9px; --pn-r-md: 12px; --pn-r-lg: 18px; --pn-r-pill: 999px;

  /* --- 8 · elevation (depth + optional glow) ------------------------------ */
  --pn-sh-sm:  0 1px 2px rgba(12,12,34,0.06);
  --pn-sh-md:  0 4px 16px rgba(12,12,34,0.08), 0 14px 40px rgba(12,12,34,0.10);
  --pn-sh-pop: 0 20px 52px rgba(12,12,34,0.20);

  /* --- 9 · motion --------------------------------------------------------- */
  --pn-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --pn-ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --pn-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --pn-dur-fast: 120ms; --pn-dur-base: 180ms; --pn-dur-slow: 280ms;

  /* module base */
  font-family: var(--pn-ui);
  font-size: var(--pn-fs-body);
  line-height: var(--pn-lh-body);
  color: var(--pn-ink);
  background-color: var(--pn-paper);
  background-image: var(--pn-aurora);
  background-attachment: fixed;
}

/* Dark = hero. Deep aurora, dark frosted glass. */
.cv2-root[data-theme="dark"],
[data-theme="dark"] .cv2-root {
  --pn-paper:   #08080F;
  --pn-surface: rgba(22,22,40,0.55);
  --pn-card:    rgba(30,30,52,0.52);
  --pn-hover:   rgba(140,125,255,0.10);
  --pn-active:  rgba(140,125,255,0.16);

  --pn-line:    rgba(255,255,255,0.09);
  --pn-line-2:  rgba(255,255,255,0.16);

  --pn-ink:     #ECEDFB;
  --pn-ink-2:   #B7B9D8;
  --pn-ink-3:   #8385A8;
  --pn-ink-4:   #575976;

  --pn-aurora:
    radial-gradient(60% 55% at 10% 4%,  rgba(99,91,255,0.30), transparent 60%),
    radial-gradient(55% 50% at 94% 10%, rgba(255,77,157,0.20), transparent 60%),
    radial-gradient(65% 60% at 82% 98%, rgba(11,165,236,0.18), transparent 62%);

  --pn-brand:      #8B7BFF;
  --pn-brand-2:    #6D5EFC;
  --pn-brand-soft: rgba(139,123,255,0.16);
  --pn-brand-rgb:  139, 123, 255;
  --glow-brand:    0 0 0 1px rgba(139,123,255,0.40), 0 10px 34px rgba(139,123,255,0.34);
  --glow-brand-sm: 0 0 0 1px rgba(139,123,255,0.34), 0 4px 16px rgba(139,123,255,0.26);
  --glass-highlight: inset 0 1px 0 rgba(255,255,255,0.06);

  --pn-run:   #3DDC84;  --pn-run-soft:   rgba(61,220,132,0.16);
  --pn-wait:  #FBBF3C;  --pn-wait-soft:  rgba(251,191,60,0.17);
  --pn-block: #FF6B8A;  --pn-block-soft: rgba(255,107,138,0.16);
  --pn-info:  #4FC3F7;  --pn-info-soft:  rgba(79,195,247,0.16);
  --pn-idle:  #9BA0C0;  --pn-idle-soft:  rgba(155,160,192,0.18);

  --pn-sh-sm:  0 1px 2px rgba(0,0,0,0.45);
  --pn-sh-md:  0 4px 16px rgba(0,0,0,0.50), 0 16px 44px rgba(0,0,0,0.42);
  --pn-sh-pop: 0 22px 56px rgba(0,0,0,0.62);
}

/* --- semantic type classes (scoped) -------------------------------------- */
.cv2-root .t-display { font-family: var(--pn-serif); font-weight: 600; font-size: var(--pn-fs-display); line-height: var(--pn-lh-tight); letter-spacing: var(--pn-track-tight); color: var(--pn-ink); }
.cv2-root .t-h1 { font-family: var(--pn-serif); font-weight: 600; font-size: var(--pn-fs-h1); line-height: var(--pn-lh-tight); letter-spacing: var(--pn-track-tight); color: var(--pn-ink); }
.cv2-root .t-h2 { font-family: var(--pn-serif); font-weight: 600; font-size: var(--pn-fs-h2); line-height: var(--pn-lh-snug); letter-spacing: var(--pn-track-tight); color: var(--pn-ink); }
.cv2-root .t-h3 { font-family: var(--pn-ui); font-weight: 700; font-size: var(--pn-fs-h3); line-height: var(--pn-lh-snug); letter-spacing: var(--pn-track-tight); color: var(--pn-ink); }
.cv2-root .t-title { font-family: var(--pn-ui); font-weight: 600; font-size: var(--pn-fs-title); line-height: var(--pn-lh-snug); letter-spacing: var(--pn-track-tight); color: var(--pn-ink); }
.cv2-root .t-body { font-family: var(--pn-ui); font-weight: 400; font-size: var(--pn-fs-body); line-height: var(--pn-lh-body); color: var(--pn-ink-2); }
.cv2-root .t-secondary { font-family: var(--pn-ui); font-weight: 400; font-size: var(--pn-fs-sm); line-height: var(--pn-lh-body); color: var(--pn-ink-3); }
.cv2-root .t-label { font-family: var(--pn-ui); font-weight: 500; font-size: var(--pn-fs-label); color: var(--pn-ink-3); }
.cv2-root .t-eyebrow { font-family: var(--pn-mono); font-weight: 600; font-size: var(--pn-fs-micro); text-transform: uppercase; letter-spacing: var(--pn-track-mega); color: var(--pn-ink-3); }
.cv2-root .t-quote { font-family: var(--pn-serif); font-style: italic; font-weight: 400; font-size: var(--pn-fs-h3); line-height: 1.45; color: var(--pn-ink-2); }
.cv2-root .t-mono { font-family: var(--pn-mono); font-weight: 400; font-size: var(--pn-fs-mono); line-height: var(--pn-lh-body); color: var(--pn-ink-2); }
.cv2-root .t-code { font-family: var(--pn-mono); font-weight: 500; font-size: var(--pn-fs-mono); color: var(--pn-brand); }
.cv2-root .t-gradient { background: var(--grad-text); -webkit-background-clip: text; background-clip: text; color: transparent; }
```

## 3. Glass component recipes (apply across all areas)

- **Panel / card:** `background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur)); -webkit-backdrop-filter: blur(var(--glass-blur)); border: 1px solid var(--glass-border); box-shadow: var(--pn-sh-md), var(--glass-highlight); border-radius: var(--pn-r-lg);`
- **Rails / headers (structural):** translucent (`--pn-surface`) + `backdrop-filter: blur(var(--glass-blur-strong))`, `border` on the seam side only.
- **Primary button:** `background: var(--grad-brand); color: #fff; border: none;` → hover adds `box-shadow: var(--glow-brand); transform: translateY(-1px);` (transition `--pn-dur-fast`). Active/selected chips may use `--grad-brand-soft` + brand text.
- **Secondary button:** transparent glass (`--pn-surface`) + `1px var(--pn-line-2)` → hover `--pn-hover`.
- **Active nav marker:** gradient bar `background: var(--grad-brand)` + `box-shadow: var(--glow-brand-sm)`.
- **Brand mark / key headings:** may use `.t-gradient` (gradient text) sparingly (one per view max).
- **Focus-visible:** `outline: 2px solid var(--pn-brand); outline-offset: 2px;` — keep on every interactive element.
- **Big screen containers:** set background `transparent` (let the aurora show) OR a very light glass; do NOT paint them a solid opaque color.
- Respect `@media (prefers-reduced-motion: reduce)` — drop transforms/springs.

## 4. Functional vetting protocol (every area, every control)

For EACH interactive element in your area's `.tsx` (`<button>`, `onClick`, `onSubmit`,
`role="button"`, menu items, tabs, toggles, drag handles):

1. Trace its handler. Is it wired to a real store action / facade call / navigation?
2. **Wired & correct** → leave logic, restyle only.
3. **Broken / no-op** (empty handler, `onClick={() => {}}`, missing handler, obviously
   wrong target) AND the correct wiring is unambiguous from sibling code / the facade /
   the store → FIX it. Match existing patterns; do not invent new backend/contract calls.
4. **Ambiguous / needs a decision / needs a new backend op** → do NOT guess. Leave it,
   and report it under `controlsBrokenNeedsReview` with file:line and why.
5. Every control must have a visible hover + focus-visible state and an accessible label
   (`aria-label` if icon-only). Add if missing.

Never delete a feature to "fix" it. Never weaken a real handler into a stub.

## 5. Report shape (return this exactly)

```json
{
  "area": "<name>",
  "cssFilesChanged": ["..."],
  "tsxFilesChanged": ["..."],
  "controlsFound": 0,
  "controlsWiredOk": 0,
  "controlsFixed": [{"file":"","line":0,"control":"","fix":""}],
  "controlsNeedsReview": [{"file":"","line":0,"control":"","why":""}],
  "newSharedTokensRequested": [],
  "notes": ""
}
```
