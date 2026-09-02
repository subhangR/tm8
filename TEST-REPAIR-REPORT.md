# TEST-REPAIR-REPORT — Home's two modes (2026-08-30)

Branch `calm/integrate`, worktree `/home/tm8/prod-workspace/wt-calm-int`.
Gate: `npx vitest run --maxWorkers=1 src/home-page/ src/views/ src/chat-home/`
from `packages/tm8_ui_2.0`.

| | before | after |
|---|---|---|
| test files | 7 failed / 97 passed (104) | **104 passed** |
| tests | 19 failed / 906 passed / 1 skipped | **926 passed / 1 skipped** |

(+20 rather than +19: one superseded case was replaced by two, because the
claim it used to make had split in half — see `home-navigation-style`.)

Nothing was deleted. Every superseded assertion was replaced by the assertion
that is now true, with an in-file comment naming what superseded it.
Package-root guards re-run and green: `hex-ban`, `type-scale-ban`,
`no-op-handler-ban`, `fullwidth-plus-ban`, `tokens-verbatim`,
`mobile-audit-css-parity`, `home/home-guards`. `tsc -p tsconfig.json` clean.
Not committed.

---

## 1. Tests changed, and why

### 1a. Stale strings — the object is called a "chat" now (10 failures)

The structural change renamed the object on every surface that draws it
(`ChatHomeScreen.tsx`: greeting, thread head, composer placeholder, empty
state; `MobileDrawer.tsx`; `HomePage.tsx`'s untitled row). The tests pinned the
old spelling of the greeting. **The claim in each case is unchanged** — the
composer greets you where no thread is open — so only the string moved.

* `src/chat-home/new-conversation-not-stolen.test.tsx` — the `GREETING`
  constant (6 failures fed from it). Comment added at the constant.
* `src/chat-home/phone-chat-defects.test.tsx` — 2 failures, 4 call sites.
  Comment added in the describe docblock that quotes the old wording.
* `src/chat-home/ChatHomeScreen.stability.test.tsx` — 1 failure, 2 call sites.
* `src/chat-home/GateChatHome.test.tsx` — 1 failure.

I did **not** touch `cockpit-stages.test.tsx:150` or
`ChatHomeScreen.test.tsx:100`: those are prose comments quoting the old string,
they assert nothing, and they read as history rather than as a live claim.

### 1b. `src/home-page/home-navigation-style.test.ts` — "draws no divider for a panel that is not there"

**Superseded by:** the two-modes restructure (a selected kind is the whole
working area, so the middle column never comes back).

The case pinned a *pair of conditional* hides — `:not([data-kind]) .hp-live
.tch-sidebar` and `… .hp-listsep` — whose whole point was that the column and
its divider came *back* when the rail picked a kind. There is no kind mode for
that column any more. Replacements, in the same case:

* the hide is now asserted **unconditionally**, plus an explicit
  `not.toMatch(/:not\(\[data-kind\]\)/)` so the conditional cannot return —
  a stronger claim than the one it replaces, not a weaker one;
* the divider is asserted **absent from the tree**, not painted out:
  `viewTsx` (a new read of `HomeView.tsx`) must not contain `hp-listsep`, and
  `pageTsx` must not contain `listRail`. A CSS-only assertion could only ever
  have pinned that a dead control is invisible, and an invisible focusable
  control that announces `aria-controls` at a missing region is the worse of
  the two failures;
* the `.tch-root` track collapse assertion kept, de-conditioned.

**New case added** — `gives the kind's list the whole working area, and floors
both tracks when B opens`. This carries the half of the old case that had
nowhere else to go: `.hp-listmain` exists, is floored on both axes (L4 +
Flexbox 4.5), and `.hp-listmain__split` floors both tracks when an entity opens
beside the list. jsdom cannot see a track, so this is the only place these can
be pinned at all.

### 1c. `src/views/panel-resize.test.tsx` — the `Home column A` block (5 failures)

**Superseded by:** the removal of column A from Home. The block's docblock
named four rulings (2026-08-16). Two of them lost their subject entirely and
two survived with one word changed; the docblock now says exactly that, and
each case carries a `SUPERSEDES:` note.

| old case | disposition |
|---|---|
| `opens at the ruled default and drags to a width that persists` (ruling 4) | **Replaced** by `draws NO list column and no handle for one`. A remembered width for a column nobody can see is precisely the passing-test-about-a-dead-surface this repair exists to prevent: it would stay green forever against a `usePanelWidth` wired to nothing. Now asserts no `panel-resizer-left`, no `hp-list-separator`, no `hp-list-main` on bare Home, and that the chat surface *is* there. |
| `CLAMPS at the floor instead of closing` (ruling 1) | **Replaced** by `gives a selected kind the whole working area, and Home takes it back`. Ruling 1 existed because a drag could otherwise shut the panel. The claim that took its place has the same property that made ruling 1 worth a case — a live alternative that has been shipped and removed twice (a list *beside* the dashboard). Walks rail → Tasks → `hp-list-main` + `entity-list-panel`, asserts `chat-home-screen` is **not** rendered, then `home-rail-home` → dashboard back. |
| `leaves the centre its floor at maximum drag — the ceiling is SOLVED (4)` | **Replaced** by `reserves the rail and nothing else — the solver's surviving half`. The solver is still real (it must know the rail's width before it can tell whether region C fits), so the case now pins `--hp-rail` at 72 collapsed → 208 expanded → 0 when the rail is off. "0, not a 72px strip left standing" is the original ask, preserved. |
| `collapses the rail AND the list on one toggle, and comes back (2, 3)` | **Kept, restated** as `collapses the RAIL on one toggle, and comes back (2, 3)`. Rulings 2 and 3 both survive: one gesture takes the whole rail off the row, and the way back is a permanent on-screen chevron. Also now asserts the control's *words* (see §2b). |
| `remembers being collapsed, and ⌘\ is the same switch` | **Kept**, retargeted at `hp-rail-reveal`; comment updated to say the key means the icon rail (it meant "the rail and column A"). |

`HOME_LIST_MIN/DEFAULT/MAX/CHROME` and `HOME_CENTER_MIN` are no longer imported
by this file, with a comment saying why. `HOME_RAIL_EXPANDED` added.

Also in this file, `the home icon rail > opens COLLAPSED…` (1 failure) waited
on `tch-hosted-list`. Retargeted to `hp-list-main`, **and** tightened: it now
also asserts `entity-list-panel` *inside* it, because an empty `.hp-listmain`
would be the same silent no-op the line exists to catch.

### 1d. `src/views/home-trails.test.tsx` (2 failures)

Two handles moved; neither ruling did.

* `tch-hosted-list` → `hp-list-main`. The list is the same list and the same
  panel; the chat surface that used to host it is not mounted in kind mode, so
  the old handle can never appear.
* `tch-center-override` → `hp-center-trail-host`. Same node, one wrapper up —
  `HomeView` builds it, the chat surface used to be what received it. The
  ruling (a list click roots the centre, the trail rides the URL) is untouched,
  and the `p=` half of it was already passing throughout, which is what proves
  the address layer never broke.

---

## 2. Product changes — cases where the product, not the test, was wrong

### 2a. A row click in a kind list rendered nothing (fixed)

`HomeView` hands region B's entity (`centerOverride`) to `regions`, which is
consumed by `ChatHomeScreen`. In kind mode `HomePage` renders `.hp-listmain`
*instead of* `.hp-home`, and the chat surface lives inside `.hp-home` — so the
chat screen is not mounted at all. Clicking a row therefore pushed `p=` onto
the address, lit the row, and **showed the reader nothing**. That is the same
defect the rail itself had an hour earlier (a selection that renders nothing),
one level down.

I treated this as a product bug, not a stale test, and fixed the product:
`HomeView` now hands `list=` a `.hp-listmain__split` node holding the list and
the entity side by side when a centre is open. That is the arrangement this
screen has always had — list plus entity — with only the container changed.
Esc and the trail crumb walk back out exactly as before.

Files: `src/views/HomeView.tsx` (the `list=` prop), `src/home-page/home-page.css`
(`.hp-listmain__split`, both tracks floored).

### 2b. The collapse gesture's words described a region that is not drawn (fixed)

`listRail` was left standing in `HomeView` after the prop that consumed it was
removed — so it rendered **nowhere**, and with it went the only on-screen way
back out of focus mode. Subhang's ruling 3 (2026-08-16: a persistent edge
affordance is the way back, never a hover-reveal and never keyboard-only) was
silently violated: ⌘\ hid the rail and nothing on screen brought it back.

Repaired as follows.

* **The drag handle is retired, not relabelled.** A `PanelResizer` whose
  subject is not drawn is the 9px × 901px hairline this file already had to
  hide once. `hp-list-separator` / `panel-resizer-left` no longer exist on Home.
* **The chevrons survive, because the thing they collapse survives.** They now
  sit on the rail's own outer edge (`.hp-railedge`), which is the boundary of
  the thing they move, exactly where the old pair rode column A's.
* **The strings now say what the controls do:**
  * `Collapse the list panel and the icon rail` → `Collapse the icon rail`
    (title: `Collapse the icon rail (⌘\)`)
  * `Show the list panel and the icon rail` → `Show the icon rail`
    (title: `Show the icon rail (⌘\)`)
  * `aria-controls="home-view-list"` → `aria-controls="home-rail"`, and
    `HomeRail`'s `<nav>` gained `id="home-rail"` so the relationship resolves.
    A control that names a missing region is announced as a relationship that
    leads nowhere — worse than naming none.
  * testids `hp-list-collapse` / `hp-list-reveal` → `hp-rail-collapse` /
    `hp-rail-reveal`, and the CSS classes `.hp-listsep*` / `.hp-listreveal` →
    `.hp-railedge*` / `.hp-railreveal`. The old names were the last thing still
    claiming a list panel was involved.

  The label/title/`aria-controls` strings are now **asserted** in
  `panel-resize.test.tsx`, so they cannot drift back.

Files: `src/views/HomeView.tsx`, `src/views/HomeRail.tsx`,
`src/home-page/home-page.css`.

### 2c. `data-testid="hp-list-main"` added to `.hp-listmain`

A seam, not behaviour. The working area had no handle at all, and the
alternative was for three test files to reach for `entity-list-panel` and be
unable to tell "the list is on screen" from "the list is on screen *in the
right container*".

---

## 3. Left failing

**None.** The gate is green.

---

## 4. Where I believe the PRODUCT is still wrong (no test fails on it)

### 4a. The width solver still reserves 340px for a column that is not drawn

`src/views/HomeView.tsx` ~line 502–527:

```
const listPref  = usePanelWidth('home.list', HOME_LIST_DEFAULT, HOME_LIST_MIN);
const listWidth = focus ? 0 : Math.min(Math.max(HOME_LIST_MIN, listPref.width), listCeiling);
const leftFloor = focus ? HOME_CENTER_MIN
                        : railWidth + listWidth + HOME_LIST_CHROME + HOME_CENTER_MIN;
const asideMax  = Math.max(0, outerWidth - leftFloor - ASIDE_CHROME);
const overlay   = outerWidth > 0 && asideMax < ASIDE_MIN;
```

`listWidth` is ≥ `HOME_LIST_MIN` (240) and defaults to 340, plus
`HOME_LIST_CHROME` (8). Nothing on this screen occupies that space any more.
The consequences are real and both invisible to this suite:

1. **Region C is demoted to overlay ~348px too early.** `leftFloor` is inflated
   by a column that is not painted, so the drill aside stops fitting *beside*
   the working area on windows where it would fit fine.
2. **`--hp-list` is published on `.hp-host` as `340px`** — a number in the DOM
   describing a track no rule reads any more.

**Why no test catches it:** `overlay` is gated on `outerWidth > 0`, and jsdom
measures every box at 0. The overlay branch is unreachable in the entire vitest
suite by construction. This is a "measure it in a browser" defect.

**Why I did not fix it:** the correction (`listWidth = 0`, drop
`HOME_LIST_CHROME` from `leftFloor`, retire `usePanelWidth('home.list')` and
the `HOME_LIST_*` constants) flips beside↔overlay thresholds that
`aux-sheet-chrome.test.tsx`, `layout-mode-address.test.tsx` and the aside cases
in `panel-resize.test.tsx` currently pass against, and choosing the new
threshold is a layout ruling rather than a test repair. It is a small change
and I think it should be made — deliberately, with the aside cases re-measured
— rather than smuggled into this pass.

### 4b. Two different "collapse the rail" controls now overlap in meaning

With column A gone, `home-focus` (⌘\ / the edge chevron → rail width 0) and
`home-rail-collapsed` (the rail's own footer button → 208 ↔ 72) are two flags,
two controls and two storage keys producing one visual axis: 208 / 72 / 0. That
was coherent while focus mode also took a list column with it. It is now three
states of one thing reached by two unrelated affordances, and the rail's footer
button says "Collapse the rail" while the edge chevron says "Collapse the icon
rail". Both strings are *true*; the arrangement is what is confusing. Merging
them is a design decision, so I left both and pinned each one's behaviour.

### 4c. Pre-existing dead CSS I deliberately did not sweep

`.hp-chat--full` and every rule under it (including the `[data-focus='true']`
focus-mode block at `home-page.css` ~845–860) match nothing: no `.tsx` in the
package renders that class, and that was already true before this change. I
left it alone — it is not orphaned by this work, and this package's standing
rule is that a bare "unused" grep is not sufficient evidence to delete CSS.
Flagging it so it is on the record.

---

## 5. Files touched

Product (`packages/tm8_ui_2.0/src`):

* `views/HomeView.tsx` — `listRail` retired; `railReveal` + `.hp-railedge`
  chevron with corrected strings and `aria-controls`; `list=` now carries the
  centre entity beside the list.
* `views/HomeRail.tsx` — `id="home-rail"`.
* `home-page/HomePage.tsx` — `data-testid="hp-list-main"`.
* `home-page/home-page.css` — `.hp-listsep*`/`.hp-listreveal` re-roled to
  `.hp-railedge*`/`.hp-railreveal`; `.hp-listmain__split` added; the stale
  "conditioned as a set" commentary rewritten. No hex, tokens only,
  `src/styles/tokens.css` untouched.

Tests:

* `home-page/home-navigation-style.test.ts`
* `views/panel-resize.test.tsx`
* `views/home-trails.test.tsx`
* `chat-home/new-conversation-not-stolen.test.tsx`
* `chat-home/phone-chat-defects.test.tsx`
* `chat-home/ChatHomeScreen.stability.test.tsx`
* `chat-home/GateChatHome.test.tsx`

## Solo dashboard mount

Two cases in `chat-home/GateChatHome.test.tsx > dashboard route` were red after
Home began mounting the chat surface with `soloConversation`:

* *mounts the merged single home* — `getAllByText('Plan the launch sequence')`
  found ZERO, expected 1.
* *is EXACTLY TWO PANES …* — `.tch-conversation__head` was `null`.

### Root cause — two defects, not one

**1. The head was suppressed for the wrong reason.**
`chat-home/ChatHomeScreen.tsx:1695` (pre-fix) read

```
{soloConversation || centre != null ? null : (<header className="tch-conversation__head">
```

The suppression exists because Craft's `CraftChatPicker` prints the same title
one row above the transcript. But it was conditioned on `soloConversation`,
which means "the thread COLUMN belongs to the host" — a different fact. Craft is
the only host where the two coincide. The phone's header deliberately prints no
title on the chat screen (`views/MobileShell.tsx:517`), and Home's dashboard has
no picker at all, so on both of them the inference deleted the ONLY place the
open conversation named itself. The dashboard's cold-started thread was
anonymous, which is exactly what the two cases measured: the head was absent, so
the title had zero sightings.

The suspected cause in the brief — the solo effect's `else` branch at
`ChatHomeScreen.tsx:571` — is NOT the cause of these two failures, which is why
deleting it changed nothing. It is reached at boot (`selectionSpaceRef.current`
is `null`, not `spaceId`) and calls `setSelectedRootId(null)` on state that is
already `null`; the cold-start auto-open at `:756` then runs and opens the most
recent thread normally. Verified: with only fix 1 applied, the conversation
renders and the auto-open works. The branch is left as it is.

**2. Home's New chat card really was dead, and the address cannot fix it.**
`views/HomeView.tsx` derived the screen's selection straight from the address:

```
const routeThreadId = routeRoot?.type === 'chats' ? routeRoot.threadId : null;
```

Under solo, `null` is not silence — the screen reads a solo host's `null` as the
instruction "no thread, show the new-chat composer" — and every arm of that
expression produced `null`. So:

* At boot the address was already `null`; New chat's
  `navigate({ root: { type: 'chats', threadId: null } })` was the same value, the
  effect's deps never changed, and nothing happened. Identical to the phone's
  `setThreadId(null)`-from-`null` defect (MobileShell, task 01a01c3f).
* `{ type: 'chats', threadId: null }` is not even an addressable state:
  `routes/codec.ts:443-448` collapses it to the bare `/home` form on the way out
  and `:616-624` normalizes it away on the way back in. A signal the codec is
  entitled to erase cannot be the signal a button stands on.
* Two further addresses spell `null` while meaning nothing of the sort: every
  KIND root (browsing a list must not blank the conversation behind it, D6) and
  `setRoot(CHATS_ROOT)`, which writes `threadId: null` only to name the root.
  Both would have blanked the open chat once solo was declared.

### Intended behaviour, as decided and now stated by the tests

On the Home dashboard with no thread in the address, the screen opens the MOST
RECENT chat (the cold-start auto-open, unchanged and still viewer-local — it
writes no history), the conversation NAMES ITSELF in `.tch-conversation__head`,
and Home's New chat card moves it to the new-chat composer. All three are
asserted by `GateChatHome.test.tsx`.

### Changes (all under `packages/tm8_ui_2.0/src`)

* `chat-home/ChatHomeScreen.tsx` — new prop `hostNamesConversation` (default
  `false`); the head is now suppressed by that, not by `soloConversation`.
  Default is that the conversation names itself.
* `chat-home/ChatHomeSurface.tsx` — pass-through for the new prop.
* `craft/CraftScreen.tsx` — passes `hostNamesConversation`; Craft is the host
  that earns the suppression, so Craft is the host that declares it. Its
  `craft-screen.test.tsx` claim (`.tch-conversation__head` is null) still holds.
* `views/HomeView.tsx` — the open conversation is MIRRORED state
  (`chatSelection`), the way `MobileShell` mirrors it for the phone, adopted
  render-phase from the address whenever the address NAMES a thread
  (`/home/chat/{id}` — back/forward and shared links still win). A bare address
  says nothing and the mirror keeps its answer. `onShowChat` sets the mirror to
  `null` instead of navigating; `onThreadSelected` writes both; `onStageChange`
  carries the mirrored thread so a stage opened on a cold-started conversation
  is a stage OF it rather than of nothing.

Tests repaired (no test deleted; both are readiness probes whose CLAIM is
unchanged, only the query shape):

* `chat-home/new-conversation-not-stolen.test.tsx` (4 probes) and
  `chat-home/phone-chat-defects.test.tsx` (1 probe) —
  `getByText(/Plan the launch sequence/)` also matched the thread's first turn
  ("Plan the launch sequence and check what is already blocked.") and passed
  only while a solo host named the conversation nowhere. With the head back the
  substring matches twice and `getByText` refuses two. Switched to the exact
  string, which names the head — the one element that STATES which thread is
  open — matching the two probes already written that way in the same file. The
  desktop probe at `new-conversation-not-stolen.test.tsx:184` keeps its regex:
  there the thread column names it too, so the head is not the sole namer.

### Results actually observed

* `npx vitest run --maxWorkers=1 src/chat-home/GateChatHome.test.tsx` —
  4 passed (was 2 failed / 2 passed).
* `npx vitest run --maxWorkers=1 src/home-page/ src/views/ src/chat-home/` —
  **104 files, 926 passed, 1 skipped, 0 failed.**
* `npx vitest run --maxWorkers=1 src/craft/` — 31 passed (2 files), run because
  `CraftScreen` changed.
* `npx tsc -p tsconfig.json --noEmit` — exit 0, no output.
* No hex added; `src/styles/tokens.css` untouched; no CSS changed by this repair.

### Still open / believed wrong

* **The phone now draws the conversation head too**, and that is deliberate:
  `MobileShell`'s header prints no title on the chat screen (its comment reasons
  that the screen below "is a blank canvas whose whole job is to invite a first
  message", which stopped being true when cold start began auto-opening the most
  recent thread). It is the same anonymity defect as Home's. Nothing pins the
  phone's chat-screen chrome height, so no test moved — but it is a visual change
  on the phone that nobody asked for in this task and should be looked at.
* **The auto-opened conversation is still not addressable on Home.** The cold
  start writes no history by design, so a viewer who lands on the dashboard and
  reads a thread cannot copy a link to it until they select it explicitly. The
  seam for closing this exists (`onSelectionChange`, which `MobileShell` uses)
  and is deliberately NOT wired here: `navStore.navigate` is push-only, so
  publishing the auto-open would put a history entry behind every boot. A
  replace-history navigate verb is the missing piece.
* **`ChatHomeScreen.tsx:570-571`** — the solo effect's
  `if (selectionSpaceRef.current === spaceId) chooseRoot(null); else setSelectedRootId(null);`
  is still there and is still doing nothing useful at boot. It is not a defect
  today (Home no longer sends a bare `null`), but its `else` branch is now
  unreachable from any shipped host that sends `null` deliberately, so it is
  dead weight that reads like a rule.
