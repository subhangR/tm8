# The mobile audit harness — what the numbers mean, and what your lane must post

This is the instrument the mobile program is measured with. Every lane runs it, and every lane
closes its task with numbers from it.

```
cd packages/tm8-ui
bun run audit:mobile                                  # all 4 viewports x 14 routes
bun run audit:mobile -- --viewport phone-390 --route tasks     # one cell, while you work
bun run audit:mobile -- --label after                 # writes mobile-audit/after.json
```

It starts its own vite on an ephemeral port, drives system Chrome, writes
`mobile-audit/<label>.json` and a PNG per cell under `mobile-audit/screens/`. `baseline.json` in
this directory is the committed **before** — do not overwrite it; write your own label and diff.

---

## Why this exists: vitest cannot see any defect you are fixing

`vitest` runs in jsdom, and **jsdom loads no stylesheets**. Every layout assertion in this repo is
an assertion about an unstyled DOM. A full green suite over a screen with content clipped off its
right edge is the normal state of affairs here, not a hypothetical.

**A green test run is not a result.** It is not evidence about layout at all. This harness is what
replaces it.

## The measurement that matters, and the one that lies

The obvious overflow check is `document.scrollWidth > innerWidth`. **It does not work here, and it
fails silently in the direction that says everything is fine.**

Both shells lay out inside a container with `overflow: hidden` — `.shell-root` on desktop,
`.mobile-frame` on the phone. A hidden-overflow container does not extend its scrollable area; it
**clips**. Content pushed past the right edge is not scrolled-to, it is *destroyed* — and
`scrollWidth` stays exactly equal to the viewport while it happens.

From the committed baseline, the Sessions screen at 390px:

```
overflow = 9   worstRight = 504   scrollWidth = 390 / viewport 390
```

`scrollWidth` and the viewport agree perfectly. The screenshot beside it shows session names
truncated to `f…` and `s…`, a filter chip cut off mid-word at `collecti`, and the desktop detail
pane bleeding in from off-screen. **That is what `scrollWidth` calls fine.**

The check that sees it is per-element: `el.getBoundingClientRect().right > viewportWidth`.

## The fields

| field | meaning |
|---|---|
| **`overflowCount`** | **THE HEADLINE.** How many rendered elements have a right edge past the viewport. This is the number your lane moves. |
| **`worstRightEdge`** | How far past the edge the worst element reaches, in CSS px. `504` at a 390px viewport means 114px of content destroyed. |
| `overflowRoots` | The offenders with no offending *ancestor* — the handful of elements you actually have to fix, with a CSS-ish path and their text. Start here. |
| `tapTargetsUnderMin` / `tapTargetsTotal` | Controls whose **smaller side** is under 44px, over controls a thumb can hit. 44px is the HIG floor; a 200x20 control fails, because a thumb misses vertically too. |
| `tapTargetsSmallest` | The worst offenders, with sizes and paths. |
| `viewportWidth` | The reference every edge is compared against (`documentElement.clientWidth`). |
| `innerWidth` | Reported **only so you can watch it disagree** — see the trap below. Never compare against it. |
| `scrollWidth` | Context, never proof. Expect it to equal `viewportWidth` on a badly broken phone screen. |
| `worstLeftEdge` | Secondary: content clipped off the *left*. A right-edge-only instrument scores that 0. |
| `shell` / `shellOk` | Which shell actually rendered, and whether it is the one this viewport is supposed to get. |
| `problems` | Top-level. **If this array is not empty, the run is not evidence.** Read it before reading any number. |

### Counts are not comparable across viewports

`phone-430` shows *fewer* overflowing elements than `phone-390` at the *same* `worstRightEdge`
(3 vs 7, both worst 449/504). The offenders are fixed-width and do not reflow; at 430px fewer
ancestors get dragged across the line. **Compare a cell only against the same cell.**

## Four traps this harness is built around

1. **No bundled browser.** This repo's playwright is 1.58.2 and its chromium revision is not
   installed — a bare launch dies with *"download new browsers"*. The harness passes
   `channel: 'chrome'` to use system Chrome. **Do not run `playwright install`** to make that go
   away: a different browser build is a different set of numbers, and this whole program compares
   numbers across lanes and across days.

2. **No coarse pointer, no phone.** `shellFor` forks on `(pointer: coarse) && width < 500`. A
   context without `isMobile`/`hasTouch` reports a *fine* pointer at any width, so you get the
   desktop shell squeezed into 390px — a screen no user has. The harness asserts the shell it
   landed in and records a `problem` if it disagrees.

3. **`innerWidth` is not the viewport under mobile emulation.** Chrome *widens* the layout viewport
   to swallow content that overflows. Measured here at 768x1024: `clientWidth` 768, `scrollWidth`
   918, and `innerWidth` **also 918** — grown to exactly match the overflow. Comparing against
   `innerWidth` means the worse a screen gets, the more the reference grows to hide it, and the
   count falls toward zero. The harness uses `documentElement.clientWidth`.

4. **There is no way to log in.** `AuthGate` wraps the app and its dev bypass is never wired by a
   host. The harness does not try: `mobile-audit.html` + `src/mobile-audit-entry.tsx` mount
   `GateApp` **directly** over the fixture seam (`localStorage['tm8-ui:real-seam'] = '0'`). The auth
   wrapper contributes no layout, so the measured tree is production's. Never build a bypass, and
   never hand a harness a human's password.

## The viewports

| profile | size | pointer | shell | why |
|---|---|---|---|---|
| `phone-390` | 390x844 | coarse | mobile | iPhone 14/15. **The primary target.** |
| `phone-430` | 430x932 | coarse | mobile | iPhone Pro Max. |
| `tablet-768` | 768x1024 | coarse | **desktop** | Coarse at 768 is wider than the 500px cut, so it gets the desktop shell. That is current design; this lane recorded it and did not change it. |
| `desktop-1440` | 1440x900 | fine | desktop | **In daily use.** Several lanes edit shared stylesheets; a mobile fix that regresses desktop must be caught by the same run that proved the fix. |

---

## What your lane must post to close its task

On your task, four things. Anything less is not a result.

1. **BEFORE and AFTER `overflowCount` and `worstRightEdge`**, for the cells you touched, named by
   viewport and route. Take BEFORE from `baseline.json` in this directory — do not re-derive it.
2. **`tapTargetsUnderMin` before and after**, if your lane touched controls.
3. **A screenshot of the after state** from `mobile-audit/screens/`.
4. **`problems: []`** on your after-run, or an explanation of every entry. A run with a wrong shell
   or a drifted viewport is not evidence, and a `0` taken off a boot error looks exactly like a `0`
   taken off a fixed screen.

And two rules about honesty, which is the whole point of the instrument:

- **If you cannot reproduce a defect, say so plainly** rather than shipping a speculative fix.
- **If a phase is half-done, say which half.** A green vitest run is not a result — see the top of
  this file.

## Scope

Desktop and tablet rows are here as a **regression tripwire**, not as a work list. Scope every
mobile rule under the mobile shell; never edit a desktop width or floor in place.

Defects this harness found are recorded on the Lane 0 task and belong to the owning lane. An
instrument that also changes the thing it measures is worthless — if you are editing this harness
to make your number better, stop.
