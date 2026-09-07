# Top bar redesign — design, before the build

**Task:** 01a07a56 "TM8 - Top Bar UI issues" · **Artifact:** 01a07a80-4c2c-7e7c-9db5-2463083672f6
**Base:** `origin/main` 4790333c · **Package:** `packages/tm8-ui` (the product UI at `/`)
**Status:** design only. Nothing in `packages/tm8-ui/src` is modified. The only new files are
`e2e/topbar-audit-harness.{html,tsx}` and this document.

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

**Read the third column.** The bar's content is **1167 px at every width**. It does not adapt badly; it has
no adaptation mechanism, and every number below 1284 is that one fact restated.

### Five root causes

1. **No media queries.** `shell/shell.css` contains zero `@media` rules for `.shell-tabbar`. Nothing in the
   row may shrink, ellipsise or fold.
2. **The zoom lever puts the cliff on real laptops.** `styles/app.css:43` sets `zoom: 1.1` on `.cv2-root`,
   so the budget is `viewport ÷ 1.1`. `1167 × 1.1 = 1284` — the exact viewport at which the bar starts
   failing, sitting between the two machines the owner named. This is the same lever behind the nested-scope
   `1.1²` terminal bug documented in `app.css`; here it is not multiplying, it is simply unaccounted for.
3. **The refusal is the largest object in the bar.** `UiVersionSwitch` falls back to `DisabledAction`, which
   renders its reason sentence *inline*. Measured widths: **680 px at 1920**, 331 at 1512, 111 at 1280 — and
   at every one of those it wraps to 3–5 lines that escape the 41 px bar and paint over the page below.
   680 px is wider than the entire Home…Help tab group (498 px).
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
| < 780 | tabs fold into one `Home ▾` menu; switcher → monogram | same list, one popover; nothing unreachable |
| < 560 | mark steps 16 → 14 px | last resort, still above today's 11.5 |
| coarse pointer, < 500 vp | `MobileShell` already owns it | `mobile/shell-for.ts` untouched |

**The sacrifice order is written down and is the reverse of today's**: the profile menu and the tab list are
the *last* things to give way, not the first. Every zone gets `min-width: 0`, every text child gets
`text-overflow: ellipsis`, and `overflow: hidden` on the bar becomes a backstop that should never fire.

Measured on the published mockup — `scrollWidth === clientWidth`, zero clipped controls, at 1745 / 1164 /
931 / **698**. Today's bar overflows by 469 px at 698.

### Width budget

| | today | proposed | note |
|---|---|---|---|
| mark | 25 | 34 | bigger, item 5 |
| space switcher | 254 | ~150 | server line moves to the popover that already prints it |
| tabs | 498 | 498 | unchanged set, unchanged labels |
| UI-2.0 refusal | 680 | 0 | removed |
| prompts | 64 | 0 | → card |
| palette | 95 | 95 | stays |
| inbox bell | 25 | 0 | → card |
| copy link | 95 | 0 | → card |
| profile | 83 | 83 | stays |
| gaps + padding | ~65 | ~56 | |
| **intrinsic** | **1167** | **~916** | fits a **1024** viewport with the full desktop bar |

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

1. **Fix the clipping — prerequisite.** `width: min(280px, …)` → `min(320px, calc(100vw - 24px))`; every row
   label gets `min-width: 0` + `text-overflow: ellipsis`; the row's box accounts for its own padding so
   `scrollWidth` cannot exceed `clientWidth`. `overflow: hidden` stops being the only defence.
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

**A — the UI-2.0 door.** "Remove this entirely not needed" is unambiguous about the bar, and the bar is
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
| keep | Home Work Board Craft Graph CodeBrain Settings Help | centre zone; one `Home ▾` menu under 780 | same tabs, still derived from the resolved `MenuConfig` groups |
| **cut** | ⇄ Switch to UI 2.0 | removed from the bar (see decision A) | 404 on both servers today — nothing reachable is lost |
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
| 6 | delete the stale `.shell-tabbar .copy-link` selectors | `shell/shell.css` | screenshot of the card |

Steps 1–3 are independently shippable and deliver items 2 and 3 alone. Steps 4–6 deliver items 1, 4 and 5.
Nothing here touches `MobileShell`, `mobile/shell-for.ts`, or the `zoom` lever.

**Verification is by pixels at every step.** jsdom cannot see one defect in this document, and it will not be
able to see a regression in the fix either.
