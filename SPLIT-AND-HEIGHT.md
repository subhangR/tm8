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

Final run, everything in: **124 files, 1606 passed, 1 skipped, 0 failed**,
449.9s. (An earlier run mid-way through was 110 files / 1387 passed; the
difference is the three new test files and the new cases in three existing
ones.) Nothing failed at all, so nothing to attribute to starvation — the
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

## 6. Left undone, and one thing I would argue about

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
