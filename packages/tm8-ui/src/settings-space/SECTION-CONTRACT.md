# The settings section contract

Written 2026-08-16, off a user report: *"settings page is fully fucked, not
properly laid out."* Twelve sections had been built by different lanes at
different times, each transcribing the shell's head/scroll divs by hand, and
they had drifted exactly as far apart as that predicts. This file is the
agreement that stops it happening again.

**Read this before touching any `*Section.tsx` under `settings-space/`,
`settings-governance/` or `settings-credentials/`.**

---

## 1. What was actually wrong (so you fix the cause, not the symptom)

The frame fix is already landed and is NOT yours to redo:

- `.set-card` had no `flex: 1` inside a `flex-direction: column` parent, so the
  whole card collapsed to content height and the rest of the screen was bare
  paper. **Fixed.**
- The card had no `max-width`, so on a 3016px display a member's name sat at
  the far left and their role pill ~2800px away. **Fixed** — the card caps at
  `--set-card-max` and centres.
- The nav could not scroll, so on a short window the rows under the spacer were
  clipped and unreachable. **Fixed.**

What is left is per-section, and it is yours.

## 2. The three-part shape — use `SectionFrame`, do not re-type it

```tsx
import { SectionFrame, SectionAbsent } from '../settings-space';   // from another module
import { SectionFrame, SectionAbsent } from './SectionFrame';      // inside settings-space

<SectionFrame title={heading} action={<button className="set-chip">+ Invite</button>}>
  …your body…
</SectionFrame>
```

`SectionFrame` renders exactly:

| part | class | rule |
|---|---|---|
| root | `.set-section` | flex column, owns the height. **Never scrolls.** |
| head | `.set-section__head` | fixed. Title left, `action` right. |
| body | `.set-section__scroll` | the **one** scroller. |

Props:

- `measure` (default `true`) — caps the body at `--set-measure` (860px) and
  centres it. Keep it on for prose, forms, key/value records. Turn it **off**
  only for rows meant to span the card edge to edge (the member table, the
  invite list, the menu editor's two-column pair).
- `pad` (default `true`) — the standard gutters. Turn it **off** when your rows
  carry their own gutter, which full-bleed rows must, so their hairline reaches
  the card edge and reads as a table rule rather than an underline.

- `action` — a control in the head, right-aligned. **Usable, but it costs one
  extra edit**; see below. It was effectively unusable in the first wave and
  that was a defect in this document, not in the prop.

Do not pass `style={{ padding: … }}`. That inline was the drift: three sections
carried it, nine did not, and the three disagreed with the head above them.

### Filling the `action` slot: register the verb, or the guard fails you

`settings.test.tsx` runs a shell-wide sweep (`sweepEnabledControls`) asserting
that **every enabled control on this surface is on the `LIVE_VERBS` allowlist**.
The rule it enforces is a real one: *no enabled control may promise an act it
cannot perform.* Anything not on the list must be `aria-disabled` with a reason.

So a head chip that is not registered fails the suite — and the first wave's §5
forbade editing the only file where it can be registered. The axes lane built a
`＋ New axis` chip, measured that, and deleted the chip. That was the correct
call given what this document said, and this document was wrong.

**You MAY append to `LIVE_VERBS`.** Appending a delimited block to the end of an
array is the one edit to a shared file that does not conflict between parallel
lanes — different lines, clean three-way merge. What §5 protects against is
lanes *rewriting* shared files, not appending to a registry that exists to be
extended. Add your block at the end, name your section, and say **why the verb
is live** — that comment is the record of what this surface can actually do:

```js
  // <Your section>: live because <the seam op that really executes it>, or
  // "browser-local, so it never asks the seam anything" — the two reasons the
  // existing entries give. If neither is true, your control is NOT live and
  // belongs disabled-with-reason instead.
  /^＋ New axis$/,
```

Name the control for the thing it acts on (`role for <name>`, `revoke inv_…`),
so that when the sweep does fail, the offender names itself.

If your control cannot honestly perform its act, do not register it — render it
`aria-disabled` with a reason. The allowlist is not a way past the guard; it is
the place you state that the guard's question has a real answer.

## 3. One scroller per section — this is the rule people break

Two scrollers nested in one section is a real bug, not a style preference: the
outer one takes the overflow, the inner one is left with nothing to distribute,
and the content that was supposed to scroll is silently clipped instead.

If your section genuinely needs an internally scrolling pane (a preview beside
an editor), that pane must have a **bounded height of its own** — a `height`,
a `max-height`, or a grid track — and must not be `flex: 1` inside the outer
scroller.

## 3b. A shared class that pads itself cannot be nested in a padded frame

The `.set-stack` lesson, kept because it cost three lanes a measurement each.

`.set-stack` carried its own `12px var(--set-gutter)`. Dropped inside a
default-padded `SectionFrame` it produced a 36px body gutter under an 18px
title — every section that used it was visibly out of line with its own
heading, and nobody noticed until the frame gave the sections a real gutter to
be out of line WITH.

So: **if you borrow a class from `settings.css`, check whether it pads itself.**
If it does, either turn the frame's `pad` off and let the class own the gutter,
or do not borrow it — write your own. Never let both apply.

The same trap is live in the other direction: `.set-invite*` pad to 16px
because they sit inside `.set-panel`, which is itself inset. Borrowed straight
into a section body they land 2px inside `--set-gutter`.

`.set-stack` and `.set-kv*` no longer exist — every section moved to its own
grouped layout, which is the better answer anyway. A key/value dump of a DTO is
rarely the right arrangement for a record a person reads.

## 4. The four numbers

Declared on `.set-root` in `settings.css`. Use the variable, never the literal:

| token | value | what it is |
|---|---|---|
| `--set-frame-pad` | 16px | gap between card and viewport |
| `--set-card-max` | 1080px | where the card stops growing |
| `--set-measure` | 860px | the reading measure, ~95 characters |
| `--set-gutter` | 18px | the one horizontal gutter |

## 5. File ownership — stay in your lane

Each section is being worked by a different agent **in parallel**. You own
**your section's component file and your own new CSS file, and nothing else.**

- **Do NOT edit `settings.css`.** It is the shared frame and every lane touching
  it produces a merge conflict with eleven others. Need section-specific CSS?
  Create `<your-section>.css` beside your component and `import './<your-section>.css'`
  from the component itself — not from `index.ts`, which is also shared.
- **Do NOT edit `SettingsShell.tsx`, `types.ts`, or `index.ts`** unless your
  brief explicitly says to. If you believe you must, say so on your task and
  stop — a coordinator serialises it.
- Prefix every new class with your section, e.g. `.set-axes__row`. A bare
  `.row` will collide.

**The one exception, and why it is safe.** You MAY *append* a delimited block to
the end of `LIVE_VERBS` in `settings.test.tsx` to register your section's live
controls (§2). Nothing else in that file.

The distinction this rule is really drawing is **rewrite vs append**, not
"shared vs owned". Two lanes rewriting the same block conflict; two lanes
appending different blocks to the end of the same array merge cleanly. The first
wave stated the rule as "never touch shared files", which was the right
instinct and the wrong boundary: it made `SectionFrame`'s `action` prop
unfillable, and a lane correctly built a chip, measured the guard failure, and
deleted its own work. Measured after that wave: twelve lanes, zero collisions,
and `settings.css` / `SettingsShell.tsx` / `types.ts` / `index.ts` still
byte-identical to the frame commit — the ownership split worked, it was just
drawn one file too wide.

If appending is not enough — you need to *change* an existing entry, or touch
any other shared file — stop and say so on your task. That is the case a
coordinator serialises.

## 6. Tokens only

`src/hex-ban.test.ts` walks every stylesheet in this module and fails on a raw
hex value. Use the `--pn-*` tokens. For alpha follow the existing idiom:
`rgba(var(--pn-brand-rgb), a)` for brass, `color-mix(in srgb, var(--tok) N%, transparent)`
for everything else. Both themes must work — the tokens invert, raw hex does not.

## 7. What "properly laid out" means here

The bar, concretely. A section is done when:

1. It uses `SectionFrame`. No hand-rolled head or scroller.
2. At 1508×882 **and** at 900×600 it shows no clipped control and no
   horizontal page scroll.
3. No line of prose exceeds the measure.
4. Its empty/absent/error state is a real `SectionAbsent`, not a blank pane.
5. Related fields are grouped and labelled rather than stacked as a flat list
   of every field the DTO happens to carry.
6. Its existing tests still pass, and you have added one that asserts the thing
   you fixed.

## 8. Verifying without the app

The settings screen sits behind a first-run auth gate, so driving the app root
is not the route. What works — and what produced the measurements this document
is based on:

1. A temporary `// @vitest-environment jsdom` test renders your real section and
   `writeFileSync`s `container.innerHTML`. jsdom gives a faithful DOM and no
   layout.
2. Concatenate the real stylesheets (`styles/tokens.css`, `styles/canvas-extra.css`,
   `panels/honesty/honesty.css`, `settings-space/settings.css`) into one file.
3. Wrap the markup in a page that reproduces the host slot the shell is given:
   a `flex: 1; min-height: 0` column.
4. Screenshot and measure it in real Chrome via Playwright:
   `import pw from '/Users/subhang/node_modules/playwright/index.js'` (it is
   CommonJS — the named import fails), launched with
   `executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`
   (the bundled chromium is not installed).
5. Measure `offsetWidth`/`offsetHeight`, **not** `getBoundingClientRect()`:
   `.cv2-root` carries `zoom: 1.1`, so rects come back scaled.

Delete the temporary dump test before you commit.

## 9. Environment

The worktree starts with no dependencies. In the worktree root:

```
bun install --frozen-lockfile          # NOT npm — package.json uses workspace:*
(cd packages/contract && npx tsc -b)   # or every tm8-ui test fails on @tm8/contract
```

Then `cd packages/tm8-ui && npx vitest run src/settings-space/`.

`npx tsc -p tsconfig.json --noEmit` reports pre-existing errors in
`prompts/CliHelpBody.tsx` and `prompts/PromptsScreen.tsx` (unbuilt `@tm8/cli`
and `@tm8/prompt`). Those are not yours. Grep your own module out of the output.
