# Top bar redesign — the design, and what the build falsified

**Task:** 01a07a56 "TM8 - Top Bar UI issues" · **Artifact:** 01a07a80-4c2c-7e7c-9db5-2463083672f6
**Base:** `origin/main` 4790333c · **Package:** `packages/tm8-ui` (the product UI at `/`)
**Status:** BUILT — PR #600. Read the corrections block below first: this document was written before the
build and before an adversarial review, and seven of its statements survived neither.

---

## CORRECTIONS, 2026-09-07 — read these before the body

| # | this doc said | the truth | how it was found |
|---|---|---|---|
| 1 | the bar's content is **1167 px at every width** | its **minimum intrinsic** width is 1167; above a 1280 viewport `scrollWidth` reports the viewport, not the content | review, from this doc's own table |
| 2 | the UI-2.0 refusal is **680 px** | **618 CSS px**. 680 came from `getBoundingClientRect` (*after* `zoom: 1.1`) printed beside `clientWidth` totals (*before* it) | the review reasoned it from the harness source with no browser; my own result then proved it — `cardW: 310` beside `clientWidth: 280`, one box, 1.1× apart |
| 3 | intrinsic width **1167 → ~916** | **1167 → 915**, and the old "today" column summed to 1884, not 1167 | ~916 was a sum of max-content widths; a nowrap flex row's minimum is not that sum. Re-measured by removing the controls and reading the row |
| 4 | fix the card by widening 280 → 320 | **`box-sizing` is the whole fix**; the widening is cosmetic. A content-box row stays 24 px wider than whatever the card is | review |
| 5 | step 6: delete `.shell-tabbar .copy-link` | **dead work** — zero matches in this package; those selectors live only in `packages/tm8_ui_2.0` | review |
| 6 | tabs fold to `Home ▾` under 780 | **not built.** All eight tabs fit a 698 px bar, so the fold solves a problem that does not occur | the build |
| 7 | the UI-2.0 switch is **cut** | **kept**, with only its overflow fixed | the owner, after this doc was approved |

**On #4, precisely, because a later auditor cannot otherwise tell:** the *prose* ranked the widening first
and the box fix third. The *code* was never wrong — it applies both, and the box fix is the one that does
the work. A document defect, not a deviation of the build from the document.

**One defect the build introduced and removed**, recorded because no test could see it: the first grid
carried `overflow: hidden` as a "backstop", which clipped the account-menu popover. The card measured
320 px wide with all six rows present and was invisible on screen. Every test passed. A toolbar that hosts
popovers cannot clip its own overflow; the note now lives in `shell.css` so it is not re-added.

**Owner's request, verbatim (2026-09-07):**

> 1. In different screens of windows chrome , Macbook chrome based on the UI screen is not adjusting
>    first adpatable to any browser phone or laptop , laptop of differenr screensh szes..
> 2. Top switch 2.0 UI and its content is over flow remove this entirely not needed.
> 3. prompts , inbox , copy link the can be moved into profile section which is there in the top right
>    corner withj profile name tarkesh, add these into profile clean make the card very clean.
> 4. Home , work Board bar must be in center
> 5. adjust tm8 logo properly bit largr would be great , utho prod icon and its drop down can also be
>    much cleaner.
>
> Goal : To re-design top bar flow without any loss of functionality cleanly.
> Product an artifact and doc how new design will look like before executing to build.

---

## 1. How the evidence was obtained

jsdom loads no stylesheets and has no layout engine, so **no assertion in this repo can see any defect in
this document**. Everything below was measured in a browser.

`e2e/topbar-audit-harness.{html,tsx}` mounts the *real* `SpaceTabBar` with the real slots the shipped app
gives it — `SpaceSwitcher`, `UiVersionSwitch`, `CopyLinkControl`, `AccountMenu` (behind a stub
`AuthActionsContext`, because `AccountMenu` deliberately renders nothing without a gate) — inside
`.cv2-root.shell-scope > .shell-root`, so the `zoom: 1.1` scope applies exactly as it does in the app.
Fixture data is read off the owner's own screenshots. It follows the `e2e/*-harness` convention already in
this package (`category-tabs-harness`, `row-state-harness`).

Driven by Playwright in `mcr.microsoft.com/playwright:v1.58.2-noble` with `--network host`.
**Chromium needs `--no-sandbox --disable-dev-shm-usage --single-process --no-zygote` on this host**;
without `--single-process` the page crashes on `goto` and without `--shm-size` / `--ipc=host` `newPage()`
hangs before it. Worth writing down — it cost three attempts.

Source-of-truth check before citing prod: `systemctl show tm8-prod -p ExecMainStartTimestamp` = 2026-09-05
15:59:28 UTC, HEAD `88cd134b` dated 15:28:35 UTC (precedes it), and
`git log --since=<start> -- packages/tm8-ui/src` is **empty** — so `/opt/tm8/prod`'s source is what the
screenshots show. `git diff 88cd134b origin/main` over `shell/ auth/ ui-version/ styles/ views/GateApp.tsx`
is also empty, so `origin/main` and prod agree on this surface.

---

## 2. What is actually wrong

| viewport | bar budget (÷1.1) | bar content | overflow | controls off-screen |
|---|---|---|---|---|
| 1920 | 1745 | 1745 | 0 | 0 |
| 1512 (MBP 14) | 1375 | 1375 | 0 | 0 |
| 1440 | 1309 | 1309 | 0 | 0 |
| 1366 (Windows laptop) | 1242 | 1242 | 0 | 0 |
| **1280 (MacBook 13, scaled)** | 1164 | **1167** | **3** | **1 — the profile menu** |
| 1152 | 1047 | 1167 | 120 | 2 |
| 1024 | 931 | 1167 | 236 | 4 |
| 900 | 818 | 1167 | 349 | 6 |
| 768 | 698 | 1167 | 469 | 8 |

**Read the third column.** The bar's **minimum intrinsic width is 1167 px** — what `scrollWidth` reports
once `clientWidth` falls below it. Above a 1280 viewport those cells report the viewport instead, because a
`flex: 1` spacer absorbs the slack. It does not adapt badly; it has no adaptation mechanism, and every
number below 1284 is that one fact restated.

**Units, declared — the first version of this document did not declare them and was wrong because of it.**
Every figure here is **CSS px inside the `.cv2-root` zoom scope**. The harness derives `scale` as
`barRect.width ÷ bar.clientWidth` (= 1.100) and divides every rect by it, because `clientWidth` /
`scrollWidth` report *unzoomed* px while `getBoundingClientRect()` reports px *after* `zoom: 1.1` — a 1.1×
discrepancy that made the original tables incomparable with themselves.

### Five root causes

1. **No media queries.** `shell/shell.css` contains zero `@media` rules for `.shell-tabbar`. Nothing in the
   row may shrink, ellipsise or fold.
2. **The zoom lever puts the cliff on real laptops.** `styles/app.css:43` sets `zoom: 1.1` on `.cv2-root`,
   so the budget is `viewport ÷ 1.1`. `1167 × 1.1 = 1284` — the exact viewport at which the bar starts
   failing, sitting between the two machines the owner named. This is the same lever behind the nested-scope
   `1.1²` terminal bug documented in `app.css`; here it is not multiplying, it is simply unaccounted for.
3. **The refusal is the largest object in the bar.** `UiVersionSwitch` falls back to `DisabledAction`, which
   renders its reason sentence *inline*. Measured: **618 CSS px at 1920**, wider than the entire Home…Help
   tab group; and at a 768 viewport **100.9 px wide by 168 px tall** inside a 36 px bar. The horizontal
   number was never the real cost — it wraps to 3–5 lines that escape the bar and paint down over the page
   at *every* width, 1920 included. (`copy-link` escapes vertically at 1920 too, a second defect nobody had
   named.)
4. **DOM order is the priority order, and it is backwards.** With nothing shrinkable, all overflow is
   absorbed by whatever is last. The first control off-screen at 1280 is `auth-accountmenu` — the profile
   menu item 3 wants to load with three more things.
5. **A flex spacer cannot centre.** `shell-tabbar__spacer { flex: 1 }` pushes everything after it right; the
   tabs sit at x = 310–807 in a 1745 px bar. Centring is not achievable in this layout.

### Two defects the five items do not name

- **The profile card overflows by 24 px, today, at 1920.** Measured: card `clientWidth` 280, the Appearance
  row's content 304, the light/dark toggle's right edge **12 px past the card**, cut by the card's
  `overflow: hidden`. This is a *prerequisite* for item 3, not a follow-up: the card cannot receive three
  rows while it cannot draw two.
- **Neither server serves the 2.0 UI.** `GET /ui-2.0/` → **404** on prod (17777) and staging (8887).
  `UiVersionSwitch` probes exactly that path, so today the control is permanently a refusal that can never
  become a live link.

---

## 3. The new bar

### Layout: a three-zone grid

```
grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)

┌──────────────────────────┬─────────────────────────┬──────────────────────────┐
│ LEFT                     │ CENTER (auto)           │ RIGHT (justify: end)     │
│ [tm8] [◈ Utho Prod ▾]    │ Home Work Board Craft … │      [/ palette ⌘K] [T ▾]│
└──────────────────────────┴─────────────────────────┴──────────────────────────┘
```

The centre column is `auto` between two equal `1fr` tracks, so the tab group is centred **on the bar**,
not on whatever the left side happens to measure — item 4. Both side tracks are `minmax(0, 1fr)`, which is
what permits their contents to ellipsise instead of pushing. Measured in the mockup: the tab group's centre
lands within **1 px** of the bar's centre at every width the tabs are drawn.

Bar height 36 → **40 px** (see §6 decision B).

### The responsive ladder

Driven by **container queries on the bar's own inline size**, not viewport media queries.

> This is the deliberate part. A container query measures the bar *inside* the zoom scope, so no breakpoint
> has to be divided by 1.1, and none of them silently move if the `zoom: 1.1` taste experiment — which
> `app.css` labels EXPERIMENTAL — is ever retuned or dropped. Root cause 2 stops being a trap instead of
> being compensated for.

| bar width | what gives way | why that one |
|---|---|---|
| ≥ 1240 | nothing | — |
| < 1240 | palette hint → `⌘K` | pure decoration; the shortcut is the fact |
| < 1080 | profile drops the name, keeps face + caret | the face is the recognisable part; the name is inside the card |
| < 900 | tab pills tighten to 7 px padding | padding before labels; no name is ever truncated |
| < 820 | switcher → monogram only | the space name is one line down in the popover it opens, and the trigger's `aria-label` carries server and space in full |
| < 700 | the UI-2.0 door leaves the bar | last decoration to go, first below identity; the account menu keeps a row for it |
| coarse pointer, < 500 vp | `MobileShell` already owns it | `mobile/shell-for.ts` untouched |

**A rung designed here and NOT built:** tabs folding to a single `Home ▾` menu under 780. Measured during
the build, all eight tabs fit a **698 px** bar with room to spare, so the fold would have been a mechanism
for a problem that does not occur. The shipped ladder has **five** rungs, not six.

**The sacrifice order is written down and is the reverse of today's**: the profile menu and the tab list are
the *last* things to give way, not the first. Every zone gets `min-width: 0` and every text child gets
`text-overflow: ellipsis`. **The bar carries no `overflow: hidden`** — the draft called for one as a
backstop, and it clipped the account-menu popover; see the corrections block.

**Measured on the shipped bar**, not on a mockup: `scrollWidth === clientWidth`, zero clipped controls and
zero vertical escapes at **1920 / 1512 / 1366 / 1280 / 1024 / 900 / 768**. Today's bar overflows by 469 px
at 698.

### Width budget

**CORRECTED — this table used to sum max-content widths and it did not add up** (its "today" column summed
to 1884 against a printed total of 1167, because a nowrap flex row's minimum is *not* the sum of its
children's natural widths). It is now a **measurement**, taken the only honest way: mount the bar with the
controls, mount it without them, and read the minimum intrinsic width both times in one unit regime.

| | minimum intrinsic width | vertical escapes at 1920 |
|---|---|---|
| today | **1167** | `hon-disabled-group`, `copy-link` |
| the three utilities moved out | **915** | none |

**Removing them saves 252 CSS px** — not the 680 the first draft implied. 915 fits a **1024** viewport
(budget 931) with the full desktop bar, and the ladder carries it below that.

**Why the palette hint stays when everything else leaves.** It is the one control whose job is to reach the
others. Folding prompts, inbox and copy link into a menu is only safe while there is a visible,
always-present way to reach every verb by name. Hiding the finder along with the found is how a "clean" bar
becomes an unusable one.

### Item 5 in detail

- **Mark.** `.shell-tabbar__mark` font-size 11.5 → **16 px**. `BrandMark` inherits font, size and colour from
  its host line by design, so both the letters and the `RibbonMark` scale with one number. No asset change,
  no new type.
- **Switcher.** The trigger becomes one line: monogram tile (19 px, with the reachability dot on its corner)
  + **space name** at 13/600 + caret. The server line leaves the trigger — it is already the popover's own
  section header, so the bar was printing the same fact twice. Full `server · space` stays on the trigger's
  `title`. 254 → ~150 px.
- **Popover.** Content unchanged: the server section with its status dot, all spaces with the check on the
  active one, `+ new space` and `+ add server`, both keeping the D28 posture. Widened 253 → 260 px so
  "Northlake demo" cannot ellipsise.

---

## 4. The profile card

Three changes, in this order:

1. **Fix the clipping — prerequisite, and `box-sizing` is the whole fix.** `.auth-menu__row` is
   `width: 100%` with `padding: 7px 12px` and no `box-sizing` anywhere in `auth.css`, so every row's border
   box is **24 px wider than the card**, whatever the card's width is. `box-sizing: border-box` +
   `min-width: 0` + `max-width: 100%` is the correction; the 280 → 320 widening is **cosmetic**, and this
   step originally led with it, which was wrong. (The code applies both and always did — a defect in the
   prose, not a deviation of the build from the design.) `overflow: hidden` stops being the only defence.
2. **Add the utility group** above Appearance: **Inbox**, **System prompts**, **Copy link to this space**.
3. **Keep the D28 posture on Inbox.** Unwired, the row stays drawn, focusable, named, and carries its reason.
   The bell has that posture today; the move must not quietly delete it.

Copy link keeps the hover sentence the owner asked for on 2026-08-31, already written as `SPACE_LINK_HINT`
in the other package:

> Copies a link to this space, opened at this page. Anyone you send it to lands exactly here and can see this
> space — its conversations, people and work — once they sign in with an account that is already in this
> space. Share it only with people you want inside.

---

## 5. Item 3 is a port, not a new design

The owner made this request once already, on **2026-08-31**. It was designed, built and tested — into
`packages/tm8_ui_2.0`, which *was* the product UI at `/` on that date.

| date | commit | what happened |
|---|---|---|
| 08-29 | `672df036` | product UI relocated to `tm8_ui_2.0`; `tm8-ui` frozen as the 1.0 snapshot |
| 08-31 | — | owner asks for inbox + copy link in the profile. Built in `tm8_ui_2.0` — the correct package that day |
| 09-02 | `3974c62b` | #566, the calm pass — also `tm8_ui_2.0`. `TOPBAR-MOVE.md` lands with it |
| 09-04 | `7b155330` | #581 reverses the relocation. `tm8-ui` is the product at `/` again — **without the profile-menu work** |

Verified rather than assumed: `utilityRows` is **4×** in `packages/tm8_ui_2.0/src/auth/AccountMenu.tsx` and
**0×** in `packages/tm8-ui/src/auth/AccountMenu.tsx`, on `origin/main`. The port source is already in this
worktree.

`672df036`'s "freeze tm8-ui as the 1.0 snapshot" is **superseded by #581**, not still in force —
`deploy/prod/run-ui.sh` serves `packages/tm8-ui/dist` at prod's 7777, and `packages/tm8_ui_2.0/dist` does
not exist on this box, which is precisely why the bar says "this server does not serve the 2.0 UI".

**Correction to `TOPBAR-MOVE.md`:** its scope note ends "Nothing committed, built, deployed or restarted."
That line is stale — the work is committed and on `origin/main`.

What comes across with the port: the `onOpenInbox` / `utilityRows` prop split (and why they are two props —
the menu must *own* Inbox to preserve its refusal posture, and must *not* own copy link, which carries a URL
codec and a clipboard refusal ladder); the group markup; the hover wording; the CSS; and — this one matters —
**the removal of the stale `.shell-tabbar .copy-link` / `.copy-link__button` descendant selectors.** The card
is a descendant of the bar, so those keep matching the control at its new address, at specificity (0,3,0)
against `.auth-menu__row`'s (0,2,0), and would dress a menu row as a 32 px bordered bar chip. A stale
descendant selector is not inert once the element it names moves underneath it.

---

## 6. Two decisions for the owner

**A — the UI-2.0 door. SUPERSEDED 2026-09-07:** the owner ruled that the switch stays, as part of the
rollback story, so it is kept and only its overflow is fixed. The argument below is left standing rather
than deleted because it was *also* built on a false premise (correction #5's neighbour: `dist-2.0` exists
and `deploy/prod/env.sh:92` exports the variable unconditionally, so "an operator may never configure it"
was never true) — and a struck argument teaches a later reader more than a vanished one.

*(original, superseded)* **A — the UI-2.0 door.** "Remove this entirely not needed" is unambiguous about the bar, and the bar is
where it hurts. But it is also the only way to reach `/ui-2.0/` without typing a URL, and it mediates two
really-deployed bundles.
*Recommendation:* delete it from the bar; add it to the profile card as a row that renders **only** when the
probe answers `available`, never as a refusal. Both servers 404 that path today, so the row is invisible and
the outcome is exactly what was asked; if an operator ever sets `TM8_UI_2_0_DIR`, the door reappears for zero
pixels in the bar. Say the word and it is deleted outright instead.

**B — the bar grows 36 → 40 px.** A 16 px mark and a 26 px switcher pill need 40 px to sit in without
crowding; at `zoom: 1.1` that is 4½ real pixels off every screen. *Recommendation: take the 4 px* — item 5
asked for a bigger mark, and 38 would deliver a compromise nobody asked for. Trivially reversible.

---

## 7. Nothing is lost — the inventory

| | control today | where it goes | still reachable by |
|---|---|---|---|
| keep | tm8 mark → conversations | left zone, 11.5 → 16 px | click the mark; `aria-label` unchanged |
| keep | space ⋄ server switcher | left zone, ~150 px, one line | same popover, same spaces, same `+ new space` / `+ add server` |
| keep | server name on the trigger | popover header + trigger `title` | hover, or open the popover — where it already appears |
| keep | Home Work Board Craft Graph CodeBrain Settings Help | centre zone, all eight at every built width | same tabs, still derived from the resolved `MenuConfig` groups. The designed fold to `Home ▾` was not built — measured unnecessary |
| **kept** | ⇄ Switch to UI 2.0 | **stays in the bar**, refusal clamped to one line with the reason on the title | the owner ruled after this doc was approved that the door is part of the rollback story. Only the overflow was the complaint, and only the overflow was fixed |
| **move** | prompts | card row "System prompts" | profile menu, and `⌘K` |
| keep | / palette · ⌘K | right zone; `⌘K` under 1240 | unchanged, plus the shortcut it names |
| **move** | ◹ inbox bell | card row "Inbox", D28 posture preserved | profile menu, `⌘K`, and Home's NEEDS YOU section |
| **move** | ↗ Copy link | card row with `SPACE_LINK_HINT` | profile menu, and `⌘K` |
| keep | T Tarkesh ▾ | right zone; face-only under 1080 | unchanged; the name is in the card, where it always is |
| keep | Appearance, Agent tools, Account & tokens, Sign out | card, unchanged, below the new group | unchanged — and Appearance stops being clipped |

**One net loss, stated plainly:** three controls stop being one click and become two. That is the trade the
owner asked for, and the palette keeps all three at one keystroke.

---

## 8. Build plan

| # | step | files | proved by |
|---|---|---|---|
| 0 | widen the harness into a spec: `scrollWidth === clientWidth` and zero clipped controls at nine widths, both themes | `e2e/topbar-audit-harness.tsx`, new `e2e/topbar.spec.ts` | the check that would have caught this originally |
| 1 | fix the card's clipping — prerequisite for step 3 | `auth/auth.css` | harness: row content ≤ card width |
| 2 | remove the UI-2.0 switch from the bar; drop `uiSwitchSlot` rather than leave it dangling | `shell/SpaceTabBar.tsx`, `views/GateApp.tsx`, `ui-version/` | `shell.test.tsx`: a host passing the slot gets nothing on screen |
| 3 | port the utility group from `tm8_ui_2.0` | `auth/AccountMenu.tsx`, `share/CopyLinkControl.tsx`, `views/GateApp.tsx`, `auth/auth.css` | the ported suites: `gate.test.tsx`, `share-a-link.test.tsx`, `CopyLinkControl.test.tsx` |
| 4 | grid layout, centred tabs, bigger mark, one-line switcher | `shell/SpaceTabBar.tsx`, `shell/SpaceSwitcher.tsx`, `shell/shell.css` | harness: tab-group centre within 2 px of bar centre |
| 5 | the container-query ladder | `shell/shell.css` | harness at nine widths + screenshots, both themes |

**Step 6 was struck.** It called for deleting stale `.shell-tabbar .copy-link` selectors; there are **zero
matches** in this package — they exist only in `packages/tm8_ui_2.0`, and the premise was read out of the
wrong package. Steps 1–3 are independently shippable and deliver items 2 and 3 alone. Steps 4–5 deliver
items 1, 4 and 5.
Nothing here touches `MobileShell`, `mobile/shell-for.ts`, or the `zoom` lever.

**Verification is by pixels at every step.** jsdom cannot see one defect in this document, and it will not be
able to see a regression in the fix either.
