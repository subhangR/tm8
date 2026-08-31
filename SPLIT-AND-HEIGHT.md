# SPLIT-AND-HEIGHT

Home's dashboard split, the full-height law as a gate rule, and the rulings that
arrived while it was being built. Working tree: `wt-calm-int`, package
`packages/tm8_ui_2.0`. Nothing committed, built, deployed or restarted.

---

## 1. The resizer: extended, not twinned

`kit/PanelResizer.tsx` knew `side: 'left' | 'right'` — one gesture, one axis. It
now knows `'top' | 'bottom'` as well.

**Why extending beat adding.** The file's own first paragraph is the argument:
it exists because a resizable side column shipped twice — once in
`WorkspaceGrid`, once in the entity screens — and the two drifted until "the
same three regions resize in one surface and refuse in another" was a reported
defect. A second component for the up/down gesture would have been that same
mistake with a fresh coat: the floor law, the drag origin, the clamp, the
double-click and Backspace reset, the 8px hit target painting a 1px hairline,
and the subtle `aria-valuenow`-while-disabled reading (PR #213) would all have
had to be got right twice, and a fix to one would not have reached the other.

What actually differs between the axes is three lines: which coordinate the drag
measures (`clientX`/`clientY`), which arrows step (`ArrowLeft/Right` vs
`ArrowUp/Down`), and which way `aria-orientation` points. Everything else is
shared code.

`aria-orientation` reads the **opposite** word to the axis name, deliberately: a
separator that slides left and right is a *vertical* rule between two columns.
Getting that backwards announces every splitter as the wrong shape and is the
most common mistake in this pattern, so it has its own case.

**Kept intact:** drag clamps at the floor, double-click resets, Backspace/Delete
on the focused separator resets, Home/End go to the bounds, a second pointer
cannot hijack a drag, the disabled separator drops its value triplet rather than
publishing `valuenow=34, valuemin=220`, and `aria-controls` names the element
that actually moves.

**One new prop, `onBeyondFloor`.** Optional; the four pre-existing mounts pass
none and are unchanged. It reports a drag request *well* past the floor
(`COLLAPSE_SLACK = 24`) without ever letting `onResize` see an unfloored number.
It exists because the collapse gesture and the floor law otherwise contradict
each other: the first attempt lowered `minWidth` and collapsed inside
`onResize`, which makes `aria-valuemin` announce a width the pane never takes —
a lie in the one place a screen-reader user has to trust.

**`usePanelHeight`** sits beside `usePanelWidth`, sharing one body
(`useStoredExtent`) so the no-clamp-on-write law, the read-on-key-change
adjustment and the storage-refusal handling are one implementation. Separate
storage prefix (`tm8ui.panel-height.`): the split asks the key `home.side` for
two extents that have nothing to do with each other — 480px is a sensible width
for that pane and a preposterous height for it. One slot per key would hand the
stacked arrangement the number chosen for side-by-side and then overwrite it on
the first drag.

**`useElementHeight`** joins `useElementWidth` (shared body) because the stacked
ceiling has to be measured: a `vh` unit answers for the *window*, which is not
the region once a top bar, a trail strip and a gutter are paid.

---

## 2. The split, and how it behaves

`.hp-home` is a three-item grid — pane, seam, pane — with `data-split` deciding
whether the tracks are columns or rows. **The markup is identical in both
arrangements.** That is load-bearing, not tidiness: the conversation holds a
scroll position, a composer draft and possibly an in-flight read, and a JSX
branch would drop all three on every flip. `home-split.test.tsx` asserts node
*identity* across a flip — the same element objects before and after — which is
what "did not remount" means in the DOM and is a claim no screenshot could make.

Default is **vertical** (side by side), per the owner's correction. Each pane is
full height on its own: the row is a single `minmax(0, 1fr)` track, so neither
pane can be shorter than the region. Stacked, the panes share the height and the
seam decides the share.

The flip control lives **on the divider**, is drawn permanently (Subhang's
ruling 3), and its label reads off what is *drawn* rather than what is
*remembered* — under the narrow fallback the choice still says `vertical` while
the screen is stacked, and a button offering to "stack the panes" beside two
already-stacked panes describes a state that is not on screen.

### Floors, ceilings, and what happens to the chat

| | side by side | stacked |
|---|---|---|
| moved value | `.hp-side` width | `.hp-side` height |
| floor | `HOME_SIDE_W_MIN = 240` | `HOME_SIDE_H_MIN = 200` |
| default | 480 (two card columns + gap) | 300 |
| ceiling | measured: `outerWidth − rail − 8 − 360 − asideReserve` | measured: `rootHeight − 300 − 8` |
| other pane's floor | `HOME_CENTER_MIN = 360` | `HOME_LOWER_MIN = 300` |

The 200 is arithmetic, not taste: a ~60px create-verb row + 10 gap + ~24 ACTIVE
bar + 8 gap + one full 96px card row + 8 seam gutter ≈ 206.

**Dragged tall (stacked), the chat does not get crushed.** The ceiling reserves
`HOME_LOWER_MIN` out of the measured column height before the pane may take any
of it, so the conversation always keeps 300px. Without that reserve `.hp-live`
would have gone the way of every other box in this package that carries
`overflow: hidden` — §4.5 zeroes its automatic minimum size, and it would have
resolved to 2px rather than refusing.

**At the floor**, the drag clamps; keep pulling and the pane **collapses** (band
3) rather than pretending to move. Collapsing writes `--hp-side-w: 0px` and
`content-visibility: hidden` — the element and its state stay, so the scroll
position, the lens and any loaded page survive the round trip, and the remembered
extent is *not* overwritten with zero. The reveal control is drawn permanently in
the seam and the resizer is not rendered while there is nothing to resize (a
separator whose subject is not drawn is the 9px × 901px defect this package
measured once).

**Narrow viewport → stacked, at ~680px of `.hp-host`** (72 rail + 240 + 8 seam +
360 chat, with the rail collapsed and no aside). It is *measured*, not a media
query, so it moves with the rail's width and with the aside; a hard-coded
breakpoint would be wrong the moment either changed. **The fallback never
writes.** `splitChoice` is what the reader asked for and persists; `splitAxis` is
what this window can afford. Widening the window restores side-by-side with no
action — the same law as `usePanelWidth`'s no-clamp-on-write.

### The three bands (owner: "let's not squash.")

The divider never refuses to move. The **grid changes shape** instead, driven by
a container query on the pane itself — the pane's width is what the divider sets,
so the viewport cannot answer this and a JS breakpoint would answer the wrong
question.

1. **cards** — two or more columns, `grid-auto-rows: 96px`.
2. **rows** (`≤ 409px` of container) — one column of 44px rows: kind dot, title,
   kind word, time, links. Same markup, same scroller, same facts.
3. **collapsed** — the pane goes to the seam, the conversation takes the width.

409 is `2 × 200 (the card track) + 8 (the gap) + 2 (the grid's scrollbar
reserve) − 1`. `home-navigation-style.test.ts` recomputes that from the
stylesheet's own values and fails if the threshold has drifted from the track it
protects — the claim pinned is the *arithmetic*, not a number.

A two-column **clamp** was built first and then removed on the owner's ruling: a
divider that silently stops moving reads as broken and makes a genuinely wide
chat unreachable. Both of those are now rulings and the test comment says so, so
neither gets re-litigated.

### The ACTIVE grid

`max-height: 200px` is gone. The grid `flex: 1 1 auto` fills its pane and scrolls
inside it, with `min-height: 96px` as the §4.5 floor (one whole card row — half a
card is the "broken box" reading its scroll-snapping exists to avoid).
`grid-auto-rows` stays pinned in both bands (96 and 44); `align-content: start`
stays. NEEDS YOU took `flex: none` and a 40% cap so twelve things waiting on you
cannot push what is *running* off the screen.

### Clicking a card

Re-pointed from `openRight` (region C, the 440px aside) to `openCenter`. No new
path: `centerOverride` is already built from the centre trail and the chat
surface already renders it in its centre berth (`centre = centerOverride ??
stagePane`) — which *is* the other pane, at that pane's full height, with the
ACTIVE grid still beside or above it. One call changed.

---

## 3. Rulings that arrived mid-flight

**One gesture, one result (2026-08-31).** A connection now always opens in the
entity pane, in place, pushing a crumb. `openRight` is no longer a destination
for that gesture on Home; `openFromCenter`'s `inTreeOf` branch is gone (the
helper stays — `EntityView` and the workspace still ask the question for their
own layouts). This **supersedes R6's mechanism and keeps R6's reason**, and the
half that makes that true is `views/paneScrollMemory.ts`: the pane records where
each entity was scrolled to and restores it on the way back, in a *layout*
effect so no frame paints at the top.

It records on a **capture-phase listener**, not in an effect cleanup. The
cleanup shape does not work: React has already mutated the DOM by the time it
runs, so the element it reads is the incoming entity's and what gets stored under
the outgoing id is zero, every time. That failure has its own test.

**Two homes → one.** `HomeRail`'s Home row is removed. It was added for a real
defect (`activeKind: null` reads as "nothing selected"), so before removing it I
drove the deployed build: land on `/home` → click Tasks in the rail
(`/home/k/tasks`, `.hp-listmain` rendered) → click **Home in the top tab row** →
back to `/home`, `.hp-home` rendered, `.hp-listmain` gone. The tab answers, so
the rail row was pure duplication. The rail still shows which kind is current
(`aria-current="page"`), and the way back is a permanently visible on-screen
control.

**The session tree.** `HomeRow` now carries `parentId`, `counters` and `badges`
— all from the *same* summary `homeRowOf` already reads. No port widened, no
second fetch, no graph query.

- `orderActive` walks the tree depth-first: siblings ranked by the same
  running-first / most-recent rule at every level, each row followed by its own
  children. Cycle-guarded (`parentId` comes off the wire), and a row stranded by
  a cycle still comes out — work is never dropped from this strip.
- **Every session is its own card/row.** Nothing is nested away behind an
  expand, because a running child is active work.
- **Cards**: flat, with `↳ from <parent>` on a child. No indentation — in a
  wrapped grid an indent reads as misalignment. A parent that cannot be resolved
  in the current set reads `↳ sub-session` rather than an empty `↳ from `.
- **Rows**: the tree renders here. 16px a level, capped at
  `ACTIVE_INDENT_MAX_DEPTH = 4` for the *indent only* — the model is n-deep —
  with the lineage line returning as the tether past the cap.
- **Expand/collapse with pagination** (`ACTIVE_CHILD_PAGE = 6`): past N, one row
  stands in the child position saying `3 more running · 1 idle` and pages the
  next N in place. It states **running** specifically; "3 more" and "3 more
  running" are different facts. A parent defaults **open** iff a child is
  running, so nothing running is ever behind a control the reader has not
  touched. A collapsed parent still states `4 sub-sessions · 2 running` on its
  own row. The tally is counted from the **data**, never from the visible rows.
- Expansion state is viewer-local and **not persisted**: a tree worth opening
  yesterday is usually finished today.

**The links line.** Card and row both carry the same pair the entity list
composes, in the same order: PR/commit chips (capped at three **in the page**,
plus a `+N` whose tooltip lists the rest) then `TileCountBadges`. Both components
are reused, not re-implemented, so their honesty rules come with them — a zero
renders nothing, and an *absent* counter renders nothing either, because "this
server never counted" is not "there are none". When the line is empty nothing is
drawn and no width is reserved. Below ~395px of container the PR numbers collapse
to a single count chip and below 300 the badges go; **the title never clips
first** (name beats count).

The badges are mounted **read-only** here: `onToggleKind` is deliberately not
passed, because in the list panel a badge is a door onto a relation group
rendered under the tile and this strip has no such group. A badge wired to
nothing would be a control that renders and does nothing — the thing I was asked
to remove rather than leave drawn.

---

## 4. The full-height rule

Added as rule 7 in `scripts/render-gate.mjs`, plus a vertical page-scroll check
in rule 4.

**The rule.** From `.cv2-root`, walk into the biggest visible in-flow child *by
area*, while that child is either (a) ≥ 60% of its parent's height — it still
*is* the region — or (b) its parent's only in-flow child, in which case it is the
whole of what the parent holds and must fill it. Stop at a scroller. Fail when
the gap between that region's bottom and the viewport floor exceeds the
threshold.

(b) is what catches the reported defect: a full-height host with one short panel
inside it. (a) is what stops the walk descending into a short list inside a tall
panel — three rows in a 700px scroller is correct, and a rule that fired on it
would be muted within a week.

**Threshold: 120px, absolute.** The largest legitimate gutter under a region on
any audited screen is the page's own 7px bottom padding plus a hairline and
sub-pixel rounding — call it 12. The smallest band a reader calls "the screen
stops halfway" is one card row of this dashboard (96px) plus its gap (104). 120
sits an order of magnitude above every legitimate gutter and below the smallest
real band, so nothing in between can be argued about. Deliberately *not* a
percentage of the viewport: the defect is an absolute band of dead paint, and a
percentage would let a bigger one pass on a short window.

**Both of the gate's recorded mistakes bit, and one of them bit me.**

*Wrong element → "everything is broken".* Avoided by not naming selectors: the
region is found by walking, and the walk is the rule.

*`getBoundingClientRect` is post-transform.* I over-corrected. The first draft
skipped any element whose rect height disagreed with its `offsetHeight`, reading
the lesson as "never trust a rect". That skipped `.cv2-root` itself on **every
route** — the shell paints inside a ~1.1 scale, so the root is 864 layout px and
950 viewport px — and the rule audited nothing while reporting green. I caught it
only because I injected a deliberate `height: 40vh` and the gate still passed.

The correct reading is that the two questions live in different spaces: *is this
child the region* is a ratio between two boxes in the same subtree
(`offsetHeight`, and scale-invariant anyway); *does it reach the floor* is a
question about the viewport, which is composited space by definition
(`getBoundingClientRect().bottom` against `clientHeight`). The two are never
compared with each other, which is what makes mixing them safe here and unsafe in
rule 1.

Two further corrections the probe forced: the walk picks the biggest child **by
area**, because Home's 72px rail and its 1350px working area are *both* full
height and "tallest" resolved that tie by DOM order — the rule walked down the
rail and audited nine icons as the primary content region. And it **stops at a
scroller**, because a 1783px tree inside a 580px list body was the first thing it
found and its bottom edge is not a layout claim.

**Proved it can fail** (`scratchpad/spine-probe.mjs`, not committed): on all five
probed routes, clean → pass, with a `height: 40vh` injected → fail, naming the
right element.

```
home         REGION div.hp-home            gap=0px    passes
             INJECTED 40vh → hp-active__grid gap=553px FAILS
home/tasks   REGION div.lp__body           gap=41px   passes
             INJECTED 40vh → section.lp     gap=490px FAILS
entity/task  REGION div.lp__body           gap=33px   passes
             INJECTED 40vh → section.lp     gap=483px FAILS
entity/doc   REGION div.lp__body           gap=33px   passes
             INJECTED 40vh → section.lp     gap=483px FAILS
settings     REGION div.set-section__scroll gap=-17px passes
             INJECTED 40vh → same           gap=464px FAILS
```

**Routes added:** `entity/task`, `entity/session`, `entity/doc` (real ids, fetched
with `tm8 entity query --kind <k> --space <SPACE>`; a stale id reports DID NOT
RENDER, which is a loud failure about the *fixture*) and `home/chat`.

### Gate output — and what it can and cannot see

**The gate points at the DEPLOYED bundle at `https://tm8.sh`. It measures what
is live, not my working tree.** Nothing in this branch has been built or
deployed, so every source fix below is invisible to it until a deploy. I am not
claiming a green gate.

**Before** (5 routes × 2 themes, the rule set as it stood):

```
render-gate: 10 route/theme pairs rendered, 0 violation(s)
```

**After** adding the four entity routes and the full-height rule (9 routes × 2
themes):

```
render-gate: 18 route/theme pairs rendered, 36 violation(s)
```

All 36 are on the three newly-audited `/e/…` routes, in both themes, and **none
of them is the new rule** — `region-not-full-height` fires on nothing, live. The
chat, docs and tasks entity views are already full height on the deployed build;
what the new routes exposed is a different class the gate has always checked and
never been pointed at:

| violation | count (light+dark) | fixed in source |
|---|---|---|
| `kit-resizer` → `entity-view-detail` names no element | 6 | `<main>` had only a `data-testid`; given the `id` |
| `lp__kind` → `_r_0_` names no element | 6 | `aria-controls` only while the menu is open |
| `tab-connections` / `tab-discussion` / `tab-content` | 14 | `PANEL_TABS` gained `ownsPanel`; set only for the active tab that has a panel |
| `pn-surface-switch__tab` → panel not rendered | 8 | set only for the selected surface |
| `pn-fold__head` → body not rendered | 2 | set only while open |

All five are one defect: `aria-controls` naming an element that is not in the
document, which a screen reader announces and then cannot follow. `aria-selected`
/ `aria-expanded` already carry the state, and the panels keep their
`aria-labelledby` back to their tabs — the direction that can always be true.
Content has no `#tabpanel-content` in any state and never has; that is registry
data now (`ownsPanel: false`) rather than a condition, because inventing a
wrapper would have put a new div in the middle of a flex chain that has produced
a 2px pane twice.

---

## 5. Tests observed

`npx vitest run --maxWorkers=1 src/home-page/ src/views/ src/kit/ src/panels/`

Final run across the four directories plus `src/domain/`:
**134 files, 1813 passed, 1 skipped, 0 failed**, 487s.

One red along the way, worth recording because it is the system working:
`list-header-calm` pins the tab row's complete ternary with a comment saying "a
third arm changes this string and fails here", and it caught my third arm on the
first run after `bucketCountLabel` landed. Superseded claim replaced, ruling it
defends re-asserted separately.

(An earlier full run mid-pass was **124 files, 1606 passed, 1 skipped, 0
failed**, 449.9s. An earlier run before that was 110 files / 1387 passed; the
differences are the six new test files and the new cases in five existing ones.)
No failure was a timeout — every red was a named assertion resolving in
milliseconds — so nothing here is attributable to starvation, and the
`>= 30 000ms` rule had no occasion to apply.

The house guards were run separately, since they live at `src/` root and are
outside the four directories above:

```
src/token-reference-ban.test.ts  src/hex-ban.test.ts  src/type-scale-ban.test.ts
src/fullwidth-plus-ban.test.ts   src/no-op-handler-ban.test.ts
  → 5 files, 16 passed
```

That matters here because this change adds a lot of CSS: no raw hex, every bare
`var(--x)` names a defined token (the new custom properties — `--hp-side-w`,
`--hp-side-h`, `--hp-acard-tone`, `--hp-acard-depth` — are all referenced with
fallbacks, which is always legal), and `src/styles/tokens.css` is untouched.

`npx tsc -p tsconfig.json --noEmit` — clean, checked after every edit.

**Superseded claims replaced, never deleted** (each with a comment naming what
superseded it and the date):

- `home-navigation-style.test.ts` — "stacks the ways-in above the conversation"
  (which *forbade* `grid-template-columns`) → the split on either axis; and "the
  grid must have `max-height`" → the grid fills and is floored at 96px, with the
  §4.5 reasoning attached. Plus a new case pinning the band threshold's
  arithmetic.
- `panel-resize.test.tsx` — "no drag handle on Home" → there is one, and it
  controls `#hp-side` rather than a list column that is not drawn; and "the way
  back is a row in the rail" → the top bar's Home tab, with the rail's row
  asserted *gone* in the same breath.
- `list-header-calm.test.ts` — pinned the tab row's **complete two-arm ternary**,
  with a comment saying "a third arm changes this string and fails here". It did,
  on the first run after `bucketCountLabel` added the no-reconcilable-count arm.
  That is the test working, not a test in the way: the claim is now the three-arm
  expression, still pinned whole so a fourth arm fails, and the ruling it exists
  for — a zero is drawn at full ink with no demotion — is asserted separately so
  a future edit cannot trade one for the other.
- `home-open-entity-seam.test.tsx` — all four cases moved from `hp-aside` to
  `hp-center-trail-host`, with the one-berth ruling recorded in the file header.

**New:** `views/home-split.test.tsx`, `views/pane-scroll-memory.test.tsx`, the
y-axis / `onBeyondFloor` / two-slot-persistence blocks in
`kit/panel-resizer.test.tsx`, and the tree + `lineageOf` blocks in
`home-page/home-active-tail.test.ts`.

**What these tests cannot see, stated so nobody reads them as more than they
are.** `vitest` runs `css: false` here, so not one of the 1606 can observe a
rendered pixel — every CSS claim above is asserted as *source text* against the
stylesheet, and the geometry is the render gate's jurisdiction. A green suite is
not evidence that the split lays out correctly; it is evidence that the rules are
written and that the behaviour above the stylesheet is right.

---

## 5a. The full-height rule caught one — and the rule was the defect

Reported by the gate on the deployed build: `region-not-full-height:
div.tch-transcript — 170px of unused height below it`, on three route/theme
pairs. I was asked to find out why, and to say whether it was a layout
difference or a timing one.

**It was both, and the timing half was the more dangerous.**

### It is not a layout defect. The 170px is the composer.

Measured on the deployed build: `.tch-transcript` runs 135..780 and
`.tch-composer-wrap` runs 780..928 directly under it, inside a
`.tch-conversation` ending at 941. Nothing is unused — the transcript occupies
exactly the height its siblings leave it.

**My rule was measuring a deep node against the bottom of the WINDOW.** It
walked into the transcript, stopped there (a scroller), and compared that box's
bottom to `clientHeight` — ignoring everything below it. A rule that does that
will call every composer, footer and action bar in the product a defect.

### And it was non-deterministic, which is why it fired 3/18 once and 0/18 twice

Same build, same rule, different verdicts. The cause was the **60% dominance
gate sitting exactly on this layout's boundary**: Home's conversation pane is
~61% of the working area, and that fraction moves with how many active cards and
NEEDS YOU rows have loaded. Whether the walk descended one more level was decided
by **content**. A gate whose verdict depends on what the server returned that
second is not a gate.

Two runs of my own probe over the same route disagreed about `.tch-conversation`
by 266px (a 13px band once, 279px the next), and `entity/task` audited a fully
populated list one run and an empty tree the next.

### Both fixed at the root, not tuned around

**The rule now asks the question of every node, not of one.** "Occupy the height
available to it" is a statement about a box *and its container*, so that is what
is measured: at each node down the spine, the dead band between the lowest edge
of its own in-flow children and its own bottom. The viewport enters exactly
once, at the app root, where the container genuinely is the window.

That fixes both faults at once — a sibling below the region now counts as
occupying the space, and the verdict no longer depends on how far the walk gets,
because every node on the way is checked. The dominance test now only decides how
*deep* the report points, never *whether* there is one.

Plus a discriminator I had to add: **centred content is not a defect**. An empty
state centred in a tall pane leaves a band at the top as well as the bottom; a
pane that ran out leaves one only at the bottom. A bottom band is reported only
when it is more than twice the top one.

**And the gate no longer waits for a number.** `waitForTimeout(11000)` is
replaced by a settle loop: sample a geometry signature (count of laid-out boxes
plus a digest of their sizes and positions, rounded so sub-pixel jitter is not
read as motion) until it holds still for 1.2s, capped at 25s. A route that never
settles is reported as **not audited** — a third outcome beside pass and fail,
and the honest one. Auditing a half-hydrated screen is a claim about something
that was never on screen.

### Verified

- Injected-defect probe, 8 route/theme pairs: the rewritten rule fails on a
  content-sized grid row and passes clean, naming the right element.
- **Determinism: three consecutive full gate runs, 18/18 green each.** Before
  the fix the same build gave 3 violations then 0 then 0.

```
render-gate: 18 route/theme pairs rendered, 0 violation(s)   ← run 1
render-gate: 18 route/theme pairs rendered, 0 violation(s)   ← run 2
render-gate: 18 route/theme pairs rendered, 0 violation(s)   ← run 3
```

The 36 `aria-controls` violations from §4 are also gone from the live build. I am
**not** claiming my source fixes caused that — this is a shared box and other
lanes deploy; I did not verify what shipped between the two runs.

---

## 5b. `To Do 898` over 466 tasks — root cause, and the bound

### The counts are correct on the deployed build right now

I intercepted the four category reads the tasks list makes. Every one is
kind-scoped and category-filtered, and the server answers correctly:

```
kinds=["task"] filters={"category":["to_do"],"deleted":"exclude"}      => total=204
kinds=["task"] filters={"category":["in_progress"],"deleted":"exclude"} => total=142
kinds=["task"] filters={"category":["done"],"deleted":"exclude"}        => total=113
kinds=["task"] filters={"category":["cancelled"],"deleted":"exclude"}   => total=7
kinds=["task"] filters=undefined                                        => total=466
```

204 + 142 + 113 + 7 = **466 exactly**. The header renders `To Do 204 · In
Progress 142 · Done 113 · Cancelled 7`. **The reported numbers do not
reproduce.**

That also disposes of the `state.category = NULL` hypothesis: the server is
partitioning on category and getting a clean, complete partition, so the nulls in
the CLI's `--terse` projection are an artefact of that projection, not the stored
value. Worth stating because it was the offered hypothesis and it is wrong.

### The root cause, stated as asked

**Which read produced 898:** `countLabel(shown, page)` answers with the server's
total *when there is one*, and with `shown` when there is not. `shown` is the
length of the client's own row array for that filter — rows from page reads
**plus** rows the event stream projected into that cache key
(`useGateData.projectRows` files an upserted entity under every cached key whose
filter it matches). **Nothing on that path is bounded by how many entities
exist.**

**Which produced the zeros:** the three neighbouring tabs, holding neither a
server total nor any cached rows, rendered a confident `0` from the same
fallback.

Three zeros and one impossible number is exactly that shape. It is in the shared
`tabCount`, which is why the owner sees it on every kind.

### The fix — the bound is in the model, and it is a refusal

`bucketCountLabel(shown, page, universe)` in `domain/types.ts`, beside
`countLabel`. A bucket count is a claim about a subset; a subset cannot be larger
than its set. When the number on offer breaks that, the answer is **no number** —
not a clamped one.

Not clamped, deliberately: `898` shown as `466` still asserts that every task in
the space is To Do, which is false and unfalsifiable by looking at it. That is
the rail's own forbidden move ("a sliced number is a different and entirely
plausible number"). Drawing nothing says "not known yet", which is true. The tab
keeps its label, its seat and its click; `0` stays a real answer and is
rendered.

The `universe` is `countsFor(kind).total` — **the aggregate the entity rail
already draws**, so the header and the rail now answer to one number instead of
the header answering to a client-side array length. No new read. Wired at all
four `EntityListPanel` mounts (Home, Entity, Workspace ×2). An absent universe
means *unknown*, never unbounded.

`n` follows the same verdict, because it drives the landing correction — the one
number we refuse to print must not still decide which tab opens.

### One definition of a bucket — they already share it, and now that is enforced

I checked the hypothesis that the board derives category from status while the
list reads a stored field. **It is not what either does.** Both partition on
`StatusCategory`, the contract's closed union: the list header through
`CATEGORY_TABS` (registry) which sends `filters.category` to the server, the
board through `CATEGORY_SPECS` which builds one column per category. Neither
derives client-side.

The real divergence risk is the **vocabulary**: two hand-written lists of the
same four categories, in two files, that nothing forces to agree.
`domain/category-vocabulary.test.ts` now pins them — same keys, same order, same
labels, every tab filters on `category` and none on `status`, and no kind may
declare a band the board cannot draw. It is a test rather than a refactor because
`board-v2` is another lane's directory; this gets the guarantee without reaching
across the boundary and fails loudly if either moves.

**Kinds confirmed:** the check runs over `allKinds()`, so every kind that
declares a tab row is covered; `task` and `work_session` are asserted present by
name. `work_session` legitimately declares three of the four (Cancelled is
structurally unreachable for it) — narrowing is allowed, redefining is not.

---

## 5c. The controls strip scrolled sideways

Owner's screenshot: `open · MEDIUM · points · mm/dd/yyyy · mm/dd/yyyy ·
assignee` on one overflowing line with a scroll track under it.

**The rule:** `task-detail.css` had `flex-wrap: nowrap` + `overflow-x: auto` +
`scrollbar-width: thin` on `.lp__rowdetail--chips`. Now `flex-wrap: wrap`, with
the overflow and the scrollbar styling gone.

The distinction that had been lost: "wide content scrolls in its own container"
is for **tables and diagrams** — artefacts you *read*, where panning is natural.
A control strip is something you **operate**, and operating it requires seeing all
of it. A due date behind a scroll is a field most people never find.

**Checked before touching it, as asked:** the selector was already keyed on
`[data-archetype='subtree']`, not on `task`, so every kind with that panel
archetype drew the same band from the same rule — one fix, no task-shaped
exception, and a test asserts the selector stays archetype-scoped.

**The phone strip is deliberately left scrolling.** It is also `nowrap` +
`overflow-x`, and there it is correct and reasoned: a 390px viewport cannot hold
six controls on any number of lines, so the phone trades panning for height on
purpose and hides the bar. Its rules are (0,4,0) via the shell attribute and win
regardless of import order, so the wrap cannot reach it. A test pins that too, so
the next reader does not "finish the job".

Also removed: `> :last-child { margin-left: … }`, which pushed the assignee to
the far end of a single line and becomes a stray indent wherever the last chip
lands once the strip wraps.

**On the dates, as asked — the panel and the timeline agree.** The timeline's
week is *presentational and labelled*, not a stored value: `spanOf` returns
`stated: 'start' | 'end'`, `inferred: true` and a note reading "No end date set;
showing a default 7-day week from the start date (…)". The panel shows an empty
native date field. Both treat absent as absent and neither writes a default
back — so the two surfaces do not disagree about what an absent date means. The
open task about adding start/due dates is a data question, untouched here.

---

## 5d. The create cards

Owner: *"make session and create task option vertical and keep new chat
horizontal."*

New session and new task open into the **tall pane** — they have real forms
behind them (status, priority, points, start date, due date, assignee) and that
wants column height. They now carry a lead-in mark and a little more vertical
presence (`--form`). New chat opens nothing; it stays the compact horizontal
entry (`--chat`), and it is marked so that when the composer box lands at the
foot of this pane, replacing it is a removal rather than a redesign.

**No second breakpoint system.** The arrangement is the `auto-fit` track that was
already there, with the floor moved from 150px to 240px:

- side by side, the pane is ~470px of content and two 240px tracks do not fit
  (480 > 470) → **one column, the verbs stack**;
- stacked, the pane is full width → **all three across the top**.

240 is the blurb's own measure: *"Put an agent on it and watch it work"* is 36
characters, ~205px at this file's measured 5.7px/char, plus 24px of padding. The
old 150px floor fit three tracks that could not hold their own text — which is
exactly why three cards read as cramped in a 46% pane.

**A latent bug fixed on the way.** The divider was `border-left` on every card
but the first, under a comment promising it "falls away on the first of each row
so a wrapped grid never opens with a stray rule" — which `:first-child` cannot
do; it matches the first card of the *grid*, not of each row. One column made it
invisible; making the grid actually wrap would have exposed it. The divider is
now a 1px grid gap over the line colour, which draws between every neighbour in
both directions at any wrap and needs no selector to know where a row begins.

---

## 5e. Two reported overflows — one real, one a false positive

### `.hp-acard__facts` — real, and mine

Measured on the deployed bundle before the fix:

```
.hp-acard__facts scrollW=216 clientW=183 over=33
  span                "113 turns"                      flex 0/1/auto
  span.hp-acard__kids "2 sub-sessions · 2 running"     flex 0/0/auto   ← refuses to yield
  time                "56m"           past-right=+36px                 ← clipped away
```

**The culprit is the sub-session count I added with the tree**: `flex: none` on a
twenty-six-character box, sitting next to two other facts on a line with 183px.
It could not shrink, so the `<time>` was pushed out — the fact the whole strip is
*ordered by*, invisible on exactly the cards with the most to say.

Two changes, and the second matters more than the first:

1. **The time is `flex: none` and never yields; the counts shrink.** Both
   survivors are counts, so "the name beats the count" does not arbitrate;
   usefulness does, and recency wins.
2. **The sub-session count is terse.** `↳2` plus a running dot, with the full
   sentence on `title`. It reuses the lineage line's own `↳`, so it is one
   vocabulary rather than a new glyph. Running keeps a presence of its own — a
   dot, not a word — because "there is running work under this" is the fact the
   collapse ruling turns on and it must not become something you hover to find.

**And clipping a count is only safe here because the digits come first.** The
standing rule is that a count is never sliced (`577` cut to `57` is a different,
plausible number — which is why the rail *drops* its metrics instead). Both
labels lead with their number, so a right-side clip eats the unit and never a
digit: `113 tu` is the same count, and `↳` is no count at all rather than a wrong
one. A test pins that, and says in as many words that rewording either label to
lead with a word destroys the guarantee.

**Verification boundary, stated plainly:** `vitest` runs `css: false` and the
render gate measures the *deployed* bundle, which does not contain this change.
Neither can see it render today. What is verified is the source — the three
declarations the behaviour rests on — because `flex: none` reappearing on a count
is exactly the one-word regression that reads as harmless in a diff.

### `.lp__meta` on docs — not a defect

```
.lp__meta scrollW=157 clientW=128 over=29
  text-overflow=ellipsis  overflow=hidden  elementChildren=0
  text="markdown · 6 children · 1 msg"
```

**Zero element children and `text-overflow: ellipsis`.** A box that is
ellipsising *always* has `scrollWidth > clientWidth` — that inequality is the
mechanism that draws the ellipsis. The 29px is the amount of text behind it, the
ellipsis is the visible signal that there is more, and the full string is already
on `title`. The rule it obeys is the one written above it in `panels.css`: it
shrinks first and disappears before the title truncates.

So there is nothing to decide and nothing to floor — **I did not change it.**
This is a false positive of the probe, and the discriminator is exactly the
`elementChildren=0` the probe already reports.

### The probe's idea is worth keeping, and it is now rule 8

`invisible-box-causes-scroll`: for every box that scrolls horizontally, find any
descendant that sticks out past its right edge and **is not visible**
(`visibility: hidden` or `opacity: 0`; `display: none` generates no box and needs
no mention). Report it.

**Why this and not a general horizontal-overflow rule** — and the two findings
above are the argument. Legitimate content overflows its box constantly: every
`overflow-x: auto` table and diagram is a scroller by design, and every
ellipsising box overflows *as its mechanism* (`.lp__meta`, above). A general rule
fires on all of them and gets muted inside a week. An invisible contributor has
no such defence: nothing is served by a box you cannot see making a box you can
see scroll. The narrowness is what makes it trustworthy.

**Proved it can fail**, per the same discipline as rule 7 — injected a
`visibility: hidden` box in the reported shape (anchored `left: 0`, overflowing
right) into `.hp-active__grid`:

```
clean   : []
injected: ["div.hp-active__grid scrolls 1928px because div.fake-tooltip
            sits 2121px past its right edge"]
```

It reports **nothing on the live build** across all 20 route/theme pairs. I am
not claiming it caught the doc-reader tooltip — that was the coordinator's probe,
and whatever fixed it is not mine to claim.

```
render-gate: 20 route/theme pairs rendered, 0 violation(s)
```

(20 rather than 18: another lane added an `entity/doc-full` route to the gate
while I was working. My rules are intact and green on it.)

---

## 6. The chat-as-a-small-box ruling — resolved, approved, not yet built

Owner, 2026-08-31, with two screenshots (the live build with a session open on
the right; Cursor's composer): *"Task and session must be vertical, chat can be
horizontal a small box like cursor. If I click on sessions right, when click on
task it comes in place of session."*

I was asked to resolve three unknowns **before** building. They are resolved
below. I did **not** build it, and §6.4 says why — the honest short version is
that one finding changes the shape of the work and a half-build would have made
conversations unreadable on the dashboard.

### 6.0 The finding that reframes it

**The box already exists.** `ChatHomeScreen` renders a `ComposerCard`
(`.tch-composer`) that already carries every element in the Cursor screenshot: a
placeholder, an attach control (with an honest disabled-with-reason variant), a
teammate chip, a model chip, a chat-mode chip, a phase label and a send button
that becomes Stop mid-turn. Nothing needs inventing. What is wrong is only
*where it sits*: at the foot of a full-height column that fills the right pane.

So this is a relocation, and the whole difficulty is that **one component owns
both the transcript and the composer**, while the ruling requires them in two
different places.

### 6.1 (a) Where the box lives — **the foot of the grid pane**

`.hp-side`'s last child, `flex: none`, an island with margin. Not a foot row
spanning the working area; not floating.

- It is the only placement that leaves the entity pane's height **arithmetically
  untouched**. A row across the foot of `.hp-home` subtracts from the berth on
  every screen whether or not anyone is chatting, and "full height for the entity
  pane in every band" is stated as absolute. Anchoring to the grid pane means the
  berth's track stays `minmax(0, 1fr)` and the box cannot reach it even in
  principle — which is a stronger guarantee than "it is only 56px tall".
- Floating is out on the explicit constraint (must not overlap the grid) and
  because over the berth it would cover the last lines of a live terminal.
- **It is what Cursor actually does.** In the screenshot the composer is at the
  foot of the working *column*, beside the thing being read — not underneath it.
- **It survives both orientations.** Vertical: bottom-left island, the Cursor
  arrangement exactly. Stacked: foot of the top row, immediately above the seam,
  still an island, still touching nothing.
- **It survives the narrow bands with the mechanism already built.** `.hp-side`
  is already `container-name: hp-side`, so the box degrades on the same query the
  cards use: chips → icons at 409, single-line field below that. It cannot
  overlap the grid because it is a flex *sibling* of the grid, not an overlay —
  the overlap failure mode is structurally unavailable.
- **The consequence I accept and state:** collapsing the grid pane (band 3) takes
  the box with it. The reveal control is permanently visible and one press away.
  The only way to keep the box while its pane is collapsed is to float it, which
  is the option rejected above.

### 6.2 (b) A chat you open — **confirmed: it takes the berth**

I was asked to check this against the screenshots rather than take the reading.
**The screenshots do not decide it** — one shows a *session* in the berth, the
other is Cursor's composer in isolation; neither shows a chat being opened. So
the confirmation rests on two other things, and I am saying so rather than
claiming the pictures agree:

1. **Rule 1 is general, and its entire value is generality.** "Whatever you open,
   opens there" exists to kill "where a click lands depends on what you clicked"
   — the arbitrariness I removed once already for connections. A chat card sits
   in the same grid, in the same lens strip, under the same open gesture as a
   session card. Excepting it would rebuild the thing being torn down.
2. **It is forced physically.** A transcript cannot be read in a 56px box. If a
   chat did not take the berth, conversations would be unreadable on the
   dashboard — a regression, not a design.

**But the wiring is not what it looks like, and this is a real finding.** Chat
rows on the ACTIVE strip carry `kind: null` and their id is a root *message* id
(`activeRows`, `ChatThreadLite`). The `message` registry row has no
`composition: 'chat'` — so `openCenter(chatId)`, which is what a card click does
today after my earlier change, would render a **message detail panel, not a
transcript**. The correct verb already exists and is a different one:
`regions.onThreadSelected(id)`, which the chat surface owns.

So (b) is right, and "opens there" means *thread selection* for one of the three
lenses and *entity open* for the other two. That is not a violation of one-berth
— the berth is the same, and a session already gets a terminal where a task gets
a detail — but it is a second code path that has to be built deliberately rather
than assumed to fall out of `openCenter`.

### 6.3 (c) Where the draft goes — **one named target, bound at send**

The box addresses exactly one conversation and **names it in the box**:

- no chat in the berth → the target chip reads **New chat**; sending starts one;
- a chat in the berth → the chip reads that chat's title.

**The hazard the coordinator named is real and I found its mechanism.** The
berth's occupant changes underneath the box every time a card is clicked, so a
box that resolved its target at *render* and posted at *send* can post into
whatever arrived in between. Two things fix it, and both are required:

- the target is read from the same state the berth renders, **at send time**, not
  captured when the draft was started;
- the target is a **visible chip**, not a placeholder. The existing composer says
  `Reply in this chat…` — which never names the thread, so a reader cannot see it
  is wrong. A chip that changes as the berth changes is a control that can be
  caught being wrong, which is the whole difference.

The chip belongs beside the mode/teammate/model pickers in `.tch-picks`, because
those are already the thread's per-conversation settings and are already
`pinned` per thread — the same row, the same grammar.

### 6.4 Why I stopped here

**`ChatHomeScreen` is a single mount that owns the transcript and the composer
together, and the ruling needs them in two places.** Every arrangement I worked
through hits one of the failures this package has already paid for:

| approach | what breaks |
|---|---|
| Mount the surface in the box only | The transcript has nowhere to render. Chats become unreadable on Home — a regression, shipped silently. |
| Mount it twice (box + berth) | Two mounts of a screen that holds a streaming thread; the second would tear down the first's stream. `centerOverride`'s own docblock is explicit that the conversation must stay MOUNTED for exactly this reason. |
| One mount, hide the transcript with CSS in box mode | This file already records why that is wrong: *"Hiding a thing is not the same as not having it, and the difference was a dead New chat button."* The screen would still believe it owns a transcript. |
| Composer stays in the berth, box is a second composer | Two controls for one verb — the defect `HomeStart`'s docblock names, and which already forced a `+ New chat` to be pulled once. |

**The arrangement that works** is the one this branch already proves out for the
split: **one mount, one DOM position in the tree, placed by CSS.** Add
`.hp-chatbox` as a fourth child of `.hp-home`; `data-chat="box" | "pane"` on
`.hp-home` puts it either in a small area at the foot of the grid column or over
the berth. No remount, no torn stream, one composer, and the transcript stays
reachable. It needs one additive prop on `ChatHomeScreen` — `compact`, meaning
"you do not own the pane; render your composer, not your transcript" — in the
same shape and for the same reason as the existing `soloConversation`
("the host declares what it owns"), defaulting to today's behaviour so no other
mount changes.

That is a change to lane H2's screen plus a fourth grid child, a new placement
mode, the thread-selection path from (b), and the target chip from (c). It is
specified above and ready to build; it is **not** something to start and leave
half-done at the end of a pass, because the half that lands first — moving the
composer out — is exactly the half that makes chats unreadable.

### 6.5 (c), settled — and it supersedes the instruction I was given

I flagged that with a single mount the composer sits in the transcript's foot
whenever a chat holds the berth, so the box's "continue" state may never render.
That flag was taken and the answer is **the box is always NEW CHAT**.

**This supersedes the (c) I was given** ("if the box composes into the currently
open chat, it needs to say which chat"). The reason it is better is not
convenience: a control that *cannot* address the wrong thing beats one that
names the right thing correctly. The chip design put the burden on the reader to
notice and check a target that changes underneath them every time they click a
card; the single-mount design removes the target entirely. Continuing a
conversation happens where you are reading it.

So the box has one state, it says so, and the wrong-chat hazard does not exist
to be guarded against.

### 6.6 Status: approved, specified, **not built**

The arrangement in §6.4 is approved and unchanged — one mount, one DOM position,
`.hp-chatbox` as a fourth `.hp-home` child with `data-chat="box|pane"`, plus an
additive `compact` prop on `ChatHomeScreen` shaped like `soloConversation`; foot
of the grid pane, `flex: none`, an island.

Two things were re-ordered ahead of it and are done (§5a–§5d); this one is not
started. What it still needs, in order:

1. `compact` on `ChatHomeScreen` (extract the existing composer wrap to a
   variable; return it alone when compact). Default false — no other mount
   changes.
2. `.hp-chatbox` as a fourth grid child with explicit `grid-area`s per
   `data-chat`, so a missing sibling leaves an empty area rather than shifting a
   track (the `display: none` removes an item but not its track lesson).
3. The chat lens's open path: `regions.onThreadSelected` + `clearStack()`, **not**
   `openCenter` — with the comment at the branch explaining why the two paths
   are not one, per §6.2. Chat rows carry `kind: null` and a root *message* id,
   and `message` has no chat composition, so `openCenter` renders a message
   detail that looks like a broken transcript.
4. `routeThreadId = null` while in box mode, so the box is genuinely the
   new-chat composer rather than silently replying to a cold-started thread.

---

## 7. Left undone, and one thing I would argue about

**The detail pane's session subtree.** The strip's tree is built; the "full
subtree in the detail pane via the existing `session-tree` anatomy" is not.
`session-tree` is a *list tile* anatomy (`EntityListPanel`), so reusing it in the
detail pane means mounting a list panel there with its rows/pageState/loadMore
ports — a real lift in a lane I do not own. What exists today, verified by
driving the deployed build: the Connections tab does carry the hierarchy, but it
is buried among 214 `LINKED` edge rows, so the child is not findable in practice.
Worth its own task.

**Collapse/expand of subtrees was explicitly ruled in and is built**; what is
*not* built is persistence of that state, deliberately (see above).

**The chips' position in the row band.** I was asked for `dot · title · chips ·
kind · time`. What is built is `dot · title · kind · time · chips`. The chips are
a *sibling* of the open gesture and cannot be interleaved with the title, because
`LinkedPullRequestChips` renders an `<a>` per PR and an anchor inside a button is
invalid HTML whose nested interactive swallows its own clicks — the defect this
card already paid for once. Getting the exact order would mean pulling the kind
and the time out of the click target too, which enlarges the change and shrinks
the click target. Every other stated rule holds: title is the only thing that
yields, chips are `flex: none`, nothing is drawn when there are none, and the
count-chip collapse happens before the title clips. Flagged rather than done
silently.

**The `region-not-full-height` threshold is unexercised against a real
failure in CI** — it has only ever failed against an injected defect. That is the
honest status: the rule is proved capable of failing, and no live route currently
trips it.

**The narrow bands are arithmetic, not browser readings.** The 409 threshold is
derived and test-pinned; the 395 and 300 steps are budget arithmetic in the
comment and want one scheduled render pass to confirm. Flagged in the stylesheet
as PROVISIONAL, in the same terms the card's own budget block uses.

**`.hp-aside` on Home is now reachable only from an `r=` address**, since no
gesture on the screen produces one. I kept it rather than deleting it: an `r=`
deep link is a real address that must still render. If the ruling holds for a
week it should probably come out, along with `promoteDrill`.

**The chat-as-a-small-box ruling is resolved but not built** — §6. The right
pane is already the one berth for entities and a task already replaces a session
in place, so half of rule 1 is live; what is not built is the composer's
relocation, and §6.4 states the specific reason a partial build would regress.

**A correction to my own earlier report.** In §2 I wrote that clicking a card
routes through `openCenter` and that this covers all three lenses. §6.2 shows
that is wrong for **chats**: their id is a root message id whose registry row has
no chat composition, so a chat card currently opens a message detail rather than
a transcript. I found this while resolving (b), after writing §2. The claim in
§2 stands for sessions and tasks and is retracted for chats; the fix is named in
§6.2 and is part of the unbuilt work, not a separate defect.
