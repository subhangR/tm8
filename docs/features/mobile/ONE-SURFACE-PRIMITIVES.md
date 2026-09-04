# One surface at a time — the two primitives, and how to apply them

Lane 2's handoff. **Lane 3 applies these to seven more destinations**; if they are not
reusable that lane fragments into seven bespoke solutions, so this file states the contract
rather than the implementation.

Everything here is live on `EntityView` (Tasks / Sessions / Channels) and measured. See
"What moved" at the bottom.

---

## The rule

> A phone shows ONE surface. The desktop shows three columns. That is not the same screen at
> a different width — it is a different arrangement of the same state.

`MobileFrame`'s docblock has said this since the foundation landed. Making it true is what
this lane did.

---

## Primitive 1 — `useMobileSurface()`

```ts
import { useMobileSurface } from '../mobile';

const { oneSurface, sheetHost } = useMobileSurface();
```

`oneSurface` is `true` only under the phone shell. **Off the phone it is `false` and every
branch it guards is unreachable**, so a shared screen gains a phone arrangement without its
desktop arrangement being touched. That is what let this lane prove all 14 desktop-1440
screenshots byte-identical.

### How to apply it

Collapse, do not narrow:

```tsx
{oneSurface && selectedId ? null : <section className="ev-list">…</section>}
{boardMode || (oneSurface && !selectedId) ? null : <main className="ev-detail">…</main>}
{boardMode || oneSurface ? null : <PanelResizer … />}
```

**Withhold rather than `display: none`.** Hiding buys nothing — `display: none` drops the
layout box and takes the scroll offset with it, so the column is reset to the top anyway —
and it leaves the region's queries, polling and subscriptions running behind something the
viewer is actually reading. The empty `.ev-detail` on the phone was mounting a space-wide
attention query on every screen.

### Three ways a screen could have learnt this, and why the other two are wrong

| | verdict |
|---|---|
| `@media (max-width: 500px)` | **No.** The shell fork is `(pointer: coarse) && width < 500`. A media query restyles the DESKTOP shell in a narrow window — a shell in daily use that no part of this program may change. |
| `useShellKind()` inside the screen | **No.** It touches a live window, so every shared screen grows a second, independently-timed answer to a question `GateApp` already answered. Two sources of one truth is how shells drift. |
| The host states it (this) | **Yes.** `MobileShell` is only mounted when the fork says phone. It already knows. |

A context and not a prop, because `oneSurface` forgotten on one intermediate component fails
**silently**, as a squeezed desktop layout — which is the defect, reintroduced, invisibly.

---

## Primitive 2 — `<MobileSheet>`

The phone's answer to the desktop's **third column** (`.ev-aux`).

```tsx
<MobileSheet title={crumb} onDismiss={() => setAux(null)} testId="…">
  {theSameColumnYouRenderOnDesktop}
</MobileSheet>
```

Renders `null` wherever there is no phone frame, so **a screen may mount it
unconditionally** and keep ONE copy of its body. `EntityView` chooses the container and
leaves the ~60 lines of wired ports untouched:

```tsx
const wrapAux = (column) => (oneSurface ? <MobileSheet …>{column}</MobileSheet> : column);
```

Two copies would be two things to keep in step, and the one that drifts is the phone's — the
arrangement nobody has open while they work.

### A sheet, not a pushed screen

A push replaces your place; a sheet **suspends** it. Pushing the aux would put a referenced
entity in the screen stack, and backing out would walk that stack instead of returning you to
the paragraph you tapped from. The detail stays mounted underneath, dimmed.

### It is a portal, not a store

The obvious build is a module store (`present(node)` / `dismiss()`). It is wrong: a
`ReactNode` pushed into a store is a **snapshot**. It keeps rendering the props it was built
with while the screen underneath moves on — a sheet showing an entity's old title. Quiet,
plausible, hard to attribute.

As a portal the sheet stays in its owner's render tree: live props, and `dismiss` is just the
owner setting its own state. DOM position belongs to the frame (which knows where the tab bar
is); content and lifetime belong to the screen (which knows what it is showing).

### Two things that will bite you

- **The host must be in `useState`, not a ref.** A ref mutation notifies nobody, so the first
  sheet portals into `null` and simply does not appear — once, per mount.
- **The empty host must be `pointer-events: none`.** `.mobile-frame__sheet` covers the whole
  frame at `z-index: 30`. Left alone it is an invisible pane over the entire app: every tap
  lands on nothing and the app reads as frozen while looking perfectly correct.

---

## Push and pop are NOT new primitives

Deliberately. Drilling in is `useScreenStack(screenKeyOf.kind(k)).open(id)`; up is `.pop()`.
That store is shared by both shells and **already worked** — this lane changed no navigation
code and added none.

- The header chevron means **UP**: `useScreenStack(key).pop`. **Never `history.back()`**, no
  popstate listener, no `location`/`history` access. `mobile/no-router-fork.test.ts` fails the
  build over it and is right to.
- `GateApp`'s screen→URL sync turns a drill-in into `e/{id}?origin={slug}` and a step up into
  `k/{slug}`, so the stack is a **projection** of the one history, not a second one.
- Verified in a real browser on all three screens: chevron and browser Back produce the same
  address and the same screen. See `e2e/one-surface-walk.mjs`.

Full reasoning: `src/stores/backContract.ts` and `docs/features/mobile/BACK-CONTRACT.md`.

---

## Scoping CSS: `.cv2-root[data-shell='mobile']`

Never edit a desktop floor in place. Restate it under the attribute `GateApp` stamps:

```css
.cv2-root[data-shell='mobile'] .pn-panel,
.cv2-root[data-shell='mobile'] .lp { min-width: 0; }
```

- **Specificity without `!important`** — `(0,2,1)` beats the existing `(0,1,1)`, so the file
  can sit anywhere in the cascade.
- **Reverting is deleting a file**, not restoring numbers from memory.
- **It follows the shell fork, not the width.**
- **Not `:has()`** — it fails *silently* where unsupported, and the page then looks exactly
  like the bug.

`min-width: 0` rather than a smaller floor: floors arbitrate between columns competing for
one row. One surface has no such competition, so a phone-sized floor is a second magic number
to keep true.

---

## The measurement, and why overflow is the wrong number

`overflowCount` was **0 before this lane and 0 after**. It is satisfiable by *clipping* at
the viewport edge rather than by reflowing — which is what had happened. Use
`e2e/one-surface-walk.mjs` (a NEW file beside `mobile-audit.mjs`, never inside it):

| metric | means | target |
|---|---|---|
| **`foreignPaneElements`** | **THE HEADLINE.** Visible elements belonging to the non-active pane. States "one surface at a time" as one integer. | **0** |
| `cardWidthFrac` | widest content card / viewport | 1.0 |
| `fillFrac` | screen body height / content region height | 1.0 |
| `truncatedWithSlack` | ellipsised while >24px of screen was free | 0 |
| `surfaces` | columns with a box at once | 1 |

Measure the **card** (`.lp`) as well as the section. They disagreed by two orders of
magnitude: `.ev-list` solved to **2px** (390 − 8 resizer − 380 detail) while the card inside
refused `.lp`'s 200px floor and overflowed its own parent. The eye saw 200; the box model
said 2.

### What moved (phone-390, both sides on `d1311c4b`, `problems: []`, `dirty: false`)

| | tasks | sessions | channels |
|---|---|---|---|
| `foreignPaneElements` (list) | 6 → **0** | 6 → **0** | 6 → **0** |
| `foreignPaneElements` (detail open) | 123 → **0** | 113 → **0** | 72 → **0** |
| `surfaces` | 2 → **1** | 2 → **1** | 2 → **1** |
| `cardWidthFrac` | 0.518 → **1.0** | 0.518 → **1.0** | 0.518 → **1.0** |
| `fillFrac` | 0.540 → **1.0** | 0.417 → **1.0** | 0.393 → **1.0** |
| `truncatedWithSlack` | 7 → 3 | 6 → **0** | 4 → **0** |
| widest row title | — | 43px → **233px** | 22px → **197px** |
| `overflowCount` | 0 → 0 | 0 → 0 | 0 → 0 |

Desktop-1440: **all 14 screenshots byte-identical by sha256.**

---

## Two defects no metric in this program can see

Both were found only by opening the PNG. Budget for looking.

1. **`.lp__actions` is `height: 34px` + `overflow: hidden`.** On a desktop the launch pill,
   its refusal banner and the Terminal button fit one line. At 390px they wrap, the container
   does not grow, and the second line is sliced horizontally *through the letterforms*. It
   does not cross the right edge, it is inside the card, and its controls are the right size
   — every number in this program scores it fine.
2. **The sheet was covering nothing.** `entity-view.css`'s one surviving breakpoint hides
   `.ev-detail` under 1040px when aux is open. A phone is always under 1040px, so opening the
   sheet unmounted the thing it was covering. Only visible by driving it.

**Look for fixed heights on rows that wrap** when you port the next seven screens. It is the
single most common shape of phone defect in this codebase.
