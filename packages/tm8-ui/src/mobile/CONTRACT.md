# THE MOBILE SHELL CONTRACT

**Landed alone, before any lane started, and that was the point.** Three lanes (chat, entity
surfaces, launch/run) were all about to change phone geometry in the same directory. This document
and the code beside it settle the shared decisions once, so that after this lands **a lane changing
shell CSS is a defect, not a lane decision.**

Scope of the whole program, unchanged by anything here: **coarse-pointer phone only**, measured at
**390 and 430**. Nothing here is a tablet port.

---

## 1. THE `shellFor` CUT — 500, AND TABLET IS A KNOWN ACCEPTED FAILURE

**Ruled: the cut stays at `MOBILE_MAX_WIDTH = 500`.** `(pointer: coarse) && width < 500`, with the
user override winning outright. The reasons are written in full over the constant in `shell-for.ts`
and asserted in `shell-for.test.ts`; the short form:

- Raising it to cover 768 would hand every coarse tablet the **phone** arrangement — one surface, a
  five-destination tab bar — on a device with 768×1024 of room, and the phone shell has never been
  measured at any width but 390 and 430.
- The tablet overflow is **a desktop-shell reflow bug, not a shell-selection bug**: `board` reports
  the same `worstRightEdge` of 2201 at desktop-1440 as at tablet-768. Reassigning the shell would
  have hidden that, not fixed it.
- The lanes are scoped to phone; moving the cut widens their verification surface to a viewport the
  build service asserts nothing at.

**THE RECORDED OUTCOME, because silence is not an outcome (DEF-041).** The cut did not move, so
**tablet-768 remains a known, recorded failure** — `overflowCount` 9 with `worstRightEdge` 1048
against 768 on nearly every route, and 53/2201 on `board`. Nobody should later read the baseline's
tablet rows as an undiscovered bug. They are the accepted consequence of this ruling.

Its owner is a task, not a name in prose:
**`01a016b4-9359-77c6-9078-4354ba8202db`** — "Desktop-shell reflow overflow (surfaces as tablet-768)".
The cure is a tablet **arrangement**. It is not a lane item and it is not this gate.

## 2. SAFE-AREA INSETS

Four tokens on `.mobile-frame`, from `env(safe-area-inset-*)`, which resolve to `0px` on every device
without a notch or home indicator. The frame applies them: left/right as padding on the frame,
top on the header, bottom on the tab bar.

**Compose against the tokens; never re-derive `env()`.** The notice host already does this
(`bottom: calc(var(--mobile-safe-bottom) + var(--mobile-tabbar-min))`) and it is the pattern: a
region that needs to sit above the tab bar and inside the inset asks the frame for both numbers.

**The bottom inset is zeroed while the keyboard is up** — see §3.

## 3. KEYBOARD / VIEWPORT

- The frame is `calc(100dvh - var(--mobile-keyboard-inset, 0px))`. **Never `100vh`**; asserted by
  `mobile-frame.test.ts`.
- On iOS the soft keyboard **overlays** the layout viewport: `innerHeight` does not change, `dvh`
  does not change, and a bottom-anchored anything goes under the keyboard. There is no media query
  for it and `env()` has no keyboard inset. Only `visualViewport` knows.
- **`MobileFrame` measures it once** with `useKeyboardInset()` and publishes two things:
  `--mobile-keyboard-inset` (the number) and `data-keyboard="up"` (the boolean). The whole frame
  shrinks, so header, content, notices, tab bar and sheets all stay above the keyboard **without
  knowing the keyboard exists.**

**A LANE MUST NOT WIRE ITS OWN KEYBOARD LISTENER.** A composer, a modifier bar and a sheet that each
subscribe to `visualViewport` and each pick their own arithmetic is three surfaces disagreeing about
where the keyboard starts. Compose against the token. If you need something the token cannot express,
that is a contract change — ask, do not add a second listener.

## 4. SHEET VS FULL SCREEN

The phone shows **one surface**. The rule for anything additional:

- **A SHEET** when the thing is *temporary and over your place*: it covers the current screen, the
  screen stays mounted underneath, and dismissing returns you exactly where you were. Use
  `MobileSheet`. This is the phone's answer to the desktop's third column, its pins and its
  hover-cards — and to anchored popovers, which do not survive the trip to a 390px header (that is
  why the account menu is a sheet, not `auth/AccountMenu` dropped into the header).
- **A FULL SCREEN** when the thing *replaces your place* and belongs in the back stack: it is a
  navigation, it gets an address, and the phone's own back gesture walks to it.

**THE TIEBREAKER, for the case that sits on the line.** "Open an arbitrary entity" is
reference-while-reading from a chat tool-call chip and navigation from an Inbox row — same entity,
same verb, different answer. Decide by **provenance**:

> **Tapped from inside content you are reading → SHEET. Tapped in a list or an inbox whose whole
> purpose is to go there → FULL SCREEN.**

The underlying question that tiebreaker encodes is *does this need an address*. A sheet has none.

**AND A THIRD SHAPE, WHICH IS NEITHER — found by Lane A, ruled in its favour, written here so the next
lane neither converts it nor re-argues it:**

> **A surface driven from an input it must not cover is not a sheet.** A type-ahead or filter surface
> whose interaction model is "keep typing in the thing underneath" has no focusable parts to trap and
> must not be made modal. Compose it against `--mobile-keyboard-inset` and keep it out of the sheet
> host.

The axis that splits these is **what the surface is solved around**, not how big it is:

- `ComposerSelect` is an anchored popover solved around a **small trigger** — 220×264 hanging off one
  of three buttons in a foot pinned to the bottom of a keyboard-shortened frame. That is the shape the
  sheet rule was written about. Converted, correctly.
- `.ri-popover` is **full-width over a full-width composer, with no focusable parts**. Its keyboard
  contract is driven *from the textarea*, and the reader filters it *by continuing to type*.

**`MobileSheet` is `aria-modal` with a backdrop.** Making the second one a sheet would **cover the
composer being typed into and put focus outside the modal it claims to trap** — breaking the
interaction it exists to serve, in exchange for a rule written about a different shape. `aria-modal`
would also become a lie, which §8 forbids independently.

The mirror case confirms the axis rather than complicating it: `LaunchSheet` — a dialog with its own
focusable content and its own dismiss semantics — belongs *in* the sheet host. Two lanes read this
section independently and split the cases the same way; the third should not have to derive it.

**AND THE HONESTY CONSEQUENCE (a §8 item):** a sheet has no address, so while one is open the header's
`CopyLinkControl` still copies the **underlying screen's** route. Copying a link that does not name
what is on screen is exactly the class of lie §8 forbids. **RULED: sheet content is never the subject
of a share.** A surface worth sharing is a surface worth addressing, and that makes it a full screen
by the rule above — so the tiebreaker and the share rule agree rather than needing a second mechanism.

The distinction is not cosmetic: pushing what should be a sheet puts a referenced entity into the
back stack, so backing out walks the screen stack instead of returning you to the paragraph you
tapped from.

Sheets portal into the frame's host, so **position belongs to the frame and content belongs to the
screen that opened it.** Do not build a bespoke sheet; seven bespoke sheets are seven chances to
disagree about what dismiss means.

## 5. BACK / NAV CONVENTION

**One history. The shell forks and the router does not** — `no-router-fork.test.ts` enforces it.

- The header **chevron means UP, not BACK.** It pops the screen stack (the desktop's Esc). `GateApp`'s
  step-up sync turns that into the address write, which for a cold arrival from a pasted link is a
  **replace** — so a reader who followed a link taps up, lands on the list with no phantom history
  entry, and their phone's own back gesture then honestly leaves the app.
- It is rendered **only when something is open**. A chevron at a screen root is dead chrome.
- The **tab bar is the navigation at a screen root.** Five destinations, each a real route.
- Nothing in the phone shell reads or writes `location`/`history` or builds a `Route`. Navigate with
  `navigateTo`.
- **UP is defined for an entity screen too, and it is a SYNTHESIZED parent rather than a pop.** Only a
  kind screen hosts a screen stack, so an `entity` target has nothing to pop — the chevron simply did
  not render, and a cold arrival on a channel link had no up affordance at all. An entity's parent is
  a fact about the entity: its kind's collection. Not drawn when `slugOfKind` is null (`voice_channel`,
  `message`), because there is genuinely nowhere up to go.
- **UP goes through `onStepUp`, never `navigateTo`.** `navigateTo` pushes; R15 requires the first step
  up from a cold arrival to be a REPLACE, or the phone's back gesture returns you to the thing you
  just left and traps a link-follower in a two-item loop. The host owns that concession.
- **Scroll restoration:** popping back to a list restores its scroll position. A sheet preserves place
  structurally (the screen stays mounted); a pushed screen does not, so the pop path must restore it
  explicitly. Unspecified here means each lane invents a different answer.
- **Focus return:** dismissing a sheet returns focus to the control that opened it; popping a screen
  returns focus to the row that pushed it. `MobileSheet` already binds Escape — focus is the other
  half of the same promise.
- **Route state lives on the target, not in component state.** `mode` and `groupBy` are route state
  (DEF-045): a layout choice that lives in local state is neither shareable nor survivable across a
  reload, and the phone was dropping both while the desktop threaded them.

## 6. THE TOUCH-TARGET TOKEN

**`--mobile-touch-min: 44px`**, on `.mobile-frame`, beside `--mobile-header-min` and
`--mobile-tabbar-min`. It is **the floor on the smaller side** — 120×22 fails the same thumb.

Two constraints, which are **acceptance and not advice**:

- **NO blanket `button { min-height: 44px }`.** The phone renders desktop-shared components, several
  inside sheets, and a blanket rule inflates every dense one — re-triggering the fixed-height
  clipping documented at length in `mobile-screens.css` §4.
- **NO `::after` hit-area tricks.** The instrument measures `getBoundingClientRect()` **of the
  element**. A pseudo-element hit area is invisible to it and to the after-run diff: it would score
  as fixed while the thumb still missed.

**A MEASUREMENT THIS CONTRACT CITED AND HAS SINCE RETRACTED — `pn-tt__status` at 44x44.**
The gate's record cited that number as evidence the task row's state control was at bar. **It is not
evidence of that, and that much is solid.** `pn-tt__status` is a `<span>` WRAPPER
(`MaestroTaskTile.tsx`); the actual control is `button.lp__statedot`, rendered *inside* it only when
`EntityListPanel` passes `statusControl` (`list.stateControl && !treatment`). Either way, **what was
measured was the wrapper.** DEF-017 remains open on `lp__statedot`, which is its actual offender
selector.

Growing `.pn-tt__status` stays correct — it is what stops a 44px control being clipped by a 16px cell
when one IS present. It simply must not be read as evidence that a control is at bar.

**WHAT THE WRAPPER'S `title=` DOES AND DOES NOT IMPLY — three values, not two.**
It is tempting to conclude that because `lp__statedot` was not observed in the fixture census,
`statusControl` was undefined, and therefore the wrapper's `title=` was live and the row carried a
touch-dead affordance. **That is a binary, and the question is three-valued.** `statusControl`
(`EntityControls.tsx`) resolves to:

- **(a)** `button.lp__statedot[data-testid="row-state-trigger"]` — a live control. Measure ITS rect;
  the wrapper's is not the tap target. This is DEF-017's actual subject.
- **(b)** `DisabledIconControl`, a `hon-disabled` span — an HONEST REFUSAL, reached when the action is
  unavailable or `onSetState` is absent. **Excluded from the 44px bar by ledger R2**, because there is
  nothing to tap.
- **(c)** `undefined` → a plain glyph, **and only here** does the wrapper carry `title=` and become a
  hover-delivered explanation on a touch surface.

**A binary collapses (b) into (c) and invents a defect where there is an honest refusal.** Which value
holds on a given row is a question about fixture state, and it is measured, not reasoned.

**AND THE INSTRUMENT CAN SEE THIS SELECTOR — verified, so a tempting second inference is closed off.**
It would be natural to read "never observed" as evidence the census cannot match `lp__statedot` at all,
which would mean every row-scoped count in this program is suspect. It cannot be read that way:
`before-lanes-results.json` (file `01a01678-f0a9-77a9-9b4b-af78bf16054f`) records, on
`entity-list-tasks` at **both** phone widths, `button.lp__statedot` with
`testid: "row-state-trigger"` — 5 entries in `tapWorst` at 16x16 and 6 in `occluded`, blocked by its
own child `svg`. **The census has demonstrably matched this exact selector on this exact surface.** So
a null on the current three-row fixture is a fact about WHICH OF (a)/(b)/(c) those three rows are in,
not about the instrument's vision.

`MaestroTaskTile.tsx` does not contain the string `lp__statedot` because it receives that control as a
**prop** — the two are NESTED, not parallel. A grep answers *"is this string in this file"* and gets
read as *"does this renderer produce this control"*; **a control passed in as a prop is invisible to
that question.**

**THE HAZARD ONE LEVEL UP, which is why this block is worded this carefully:** the first draft of it
argued from a null result produced by an instrument, as though the null were a fact about the code. It
was a fact about the census. **An instrument cannot be the witness for its own blind spot.** When a
conclusion rests on a null, ask what would have to be true for the null to be an ARTEFACT — and go
measure that instead. Here, measuring it closed the question in the instrument's favour.

**THE SURVIVING OFFENDER HAS AN OWNER.** `input.lp__searchinput` (332x23 at 390, 372x23 at 430) is the
only sub-44 target left on tasks, sessions and channels, and being under 16px type it is *also* an iOS
zoom-on-focus row. It sits on lane-shared list surface governed by §7, which lanes may not edit — so it
is **the shell contract's**, filed as a follow-up beside the readability floor below. Assigning it now
is what stops it being everyone's and no one's.

**THE READABILITY FLOOR IS THE UNBUILT SIBLING OF THIS TOKEN.** The controls this contract grew to 44px
carry 9.5px labels (`lp__tab`, `lp__chip`, `lp__foot`), 11.5px (`lp__kind`, `lp__new`) and 11px
(`mobile-tabs__label`). **A 44px button with 9.5px text is tappable and unreadable.** Not a threshold in
this program and invisible to the tap census, which is exactly why it needs writing down.

And the one this file learnt the hard way: **unpin the container before growing what is inside it.**
`.lp__selector` (36px), `.lp__filters` (32px + `overflow: hidden`) and `.lp__actions` (34px) all clip
a control you just enlarged, and **no metric in this program can see vertical clipping** (DEF-037).

## 7. OWNERSHIP — WHAT A LANE MAY NOT TOUCH

**The shell contract owns `src/mobile/*.css`.** After this lands:

| File | Owner | A lane may… |
|---|---|---|
| `src/mobile/mobile.css` | shell contract | read it. Not edit it. |
| `src/mobile/mobile-chrome.css` | shell contract | read it. Not edit it. |
| `src/mobile/mobile-screens.css` | shell contract | read it. Not edit it. |
| `src/mobile/MobileFrame.tsx`, `MobileSheet.tsx`, `surface.tsx`, `shell-for.ts` | shell contract | use them. Not change their contracts. |
| `src/views/MobileShell.tsx` | shell contract | not edit. Chrome is not lane surface. |
| `src/panels/panels.css` | Lane B | Lane B edits it. Phone *sizing* of shared list primitives is in `mobile-screens.css` §7. |

**A LANE SELECTOR WHOSE SPECIFICITY EXISTS TO OUTWEIGH A SHELL RULE IS A SHELL CHANGE.**
Every rule in `mobile-screens.css` is `(0,2,1)` *by design*. A lane that needs a floor changed and gets
no timely ruling will restate it at `(0,3,1)` in a lane-owned stylesheet — not an edit of a shell file,
legal by the letter of the rule above, and **the exact collision this gate exists to prevent**. It is
also silent: nothing fails, the shell rule simply stops winning. Forbidden by intent, not by file path.

**If a lane needs a shell rule changed, it requests the change through the ledger.** Editing it
directly is the collision this gate exists to prevent — and because the three lanes see the *same*
shared components, a lane "just fixing its own screen" is three lanes writing one file.

**THE REQUEST PATH HAS A NAMED ARBITER AND AN SLA**, because "request through the ledger" has nobody
on the other end of it — and a ledger row does not reach a running worker. **Anchor and ledger posts do
not notify; only direct session messages do.** So: open the ledger row **and** send a direct message to
triage; the ruling comes back as a direct message; the ruling is committed to this file within one
working session. A lane blocked on an unanswered request escalates rather than reaching for
specificity.

**THE ONE SEAM THAT IS LANE-AMENDABLE, ruled once so it is not adjudicated three times.** Two of three
lanes need `MobileShell.tsx` in week one — Lane A's `messages` port lives in the refusal arm of
`screenFor`, Lane B's "open an arbitrary entity" needs a callback threaded into that same switch, and
Lane C has already asked for launch props through it.

> **`screenFor` and `MobileShellProps` are LANE-AMENDABLE via ledger-approved PR.
> The CHROME — header, tab bar, frame, sheet primitive, account sheet — is NOT.**

Two conditions on any such amendment, both already law in this file:
- **A callback is threaded as a real prop that is ABSENT when it cannot perform.** Never
  `?? (() => undefined)`. `MobileShell`'s own switch documents the regression that produced this rule:
  a handler that exists and does nothing switches off the honest states the screens check for, and
  every inbox row and tool-call chip became a live-looking control that swallowed the press.
- **The refusal arm stays honest.** A new screen means the route stops being refused; it never means
  the refusal card starts telling a story about a screen that is not there.

**FILE-LEVEL OWNERSHIP IS NECESSARY BUT NOT SUFFICIENT.** Lane A (composer) and Lane B (entity
surfaces) both touch shared input/list primitives, which are singletons here. One lane owns a shared
file; the other requests through the ledger.

### RULING — "Close panel" is REMOVED on the phone shell (DEF-023)

**Decided here, implemented by Lane B**, which owns `src/kit/`. Recorded rather than coded because
this contract's own ownership rule would make me a hypocrite for editing a lane's file.

**The ruling: remove the verb on the phone; do not resize it.**

"Close panel" is a **desktop panel-stack verb on a shell that has no panel stack.** The phone shows
one surface; there is no stack to close a panel out of, so the control is either inert or it performs
a navigation the reader never asked for. Growing it to 44px would have produced a comfortably tappable
control for an arrangement that does not exist here — the same shape as the drag handles this contract
already declines (`mobile-screens.css` §5: "a control for an arrangement the phone does not have, and
a thumb that finds it can only be disappointed by it").

"Open full view" is in the same 18×16 pair and is **kept** — the phone HAS a full view, so that verb
still means something.

For Lane B: branch on `useMobileSurface().oneSurface`, which is exactly the seam that exists for this
and is `false` on every desktop path by construction. **DEF-023 then closes `wontfix-removed`, which
the ledger records as a legitimate close and a PASS** — and Lane B states which of the two happened.

### The `data-shell` marker is a shared contract, not a private detail

`.cv2-root[data-shell='mobile']` is stamped by `GateApp` and `MobileFrame` and consumed by:

- `mobile-screens.css` — every rule in it, including the §7 override block
- `mobile-chrome.css` — **the zoom gate**
- `terminal.css` — **24 occurrences / 21 rule heads**, which is Lane C's terminal styling

**Changing, moving or re-wrapping that marker breaks all three at once**, and it presents as *"my CSS
didn't apply"* rather than as a marker fault — so the natural response is to rewrite the CSS, which
will not help, because the CSS was never the problem. **If a `[data-shell='mobile']` rule mysteriously
does not take effect, check the marker before touching the stylesheet.** It is greppable by design;
that is why it was chosen over `:has()`, which fails silently and looks identical to working.

### The zoom gate is load-bearing for every measurement in this program

`app.css` puts `zoom: 1.1` on `.cv2-root`. `mobile-chrome.css:67-69` scopes it off the phone:

```css
.cv2-root[data-shell='mobile'] { zoom: 1; }
```

**CSS `zoom` MULTIPLIES down the ancestor chain.** This is measured history in this codebase, not
theory: the work_session panel rendered at 1.21 (1.1²) and the xterm host at 1.331 (1.1³) *before its
own reciprocal*, which is why a counter-scale that looked correct in isolation still left the glyphs
oversized — for weeks. `launch-run-session` has **four** nested roots, which compounds to ~1.46.

Every number in the defect ledger rests on that gate holding: the baseline recorded `zooms: ["1"]` on
all 16 phone surfaces, and `["1","1","1","1"]` on the four-root run surface. If it silently reverts,
tap targets inflate ~10% and cross 44px **with no fix at all** — the diff would report improvements
that are pure artifact.

**Do not touch it. Walk the whole ancestor chain; never read one value and conclude.**

## 8. HONESTY RULES THIS SHELL HOLDS ITSELF TO

The phone shell's identity is honest refusal, so these are contract, not taste:

- **A refusal card must be true.** Copy is derived from `view-ref-screens.ts`, so an `unbuilt` ref
  cannot render "this link still works on a desktop" (DEF-012). It said that about `feed`, which is
  `unbuilt`, and sent readers to a desktop to look for a screen that is not there either.
- **A refusal may offer a way out, and must still refuse.** Silently aliasing a route to a working
  one makes the card a lie. The `files` card offers "Browse files as a list" *beside* its refusal
  (DEF-043).
- **No control that cannot perform.** Absent handler ⇒ absent control, never a live-looking one that
  swallows the press. Passing `() => undefined` to a component that checks whether a handler EXISTS
  switches its honest state off — this is why the account sheet's optional verbs are spread rather
  than defaulted.
- **No `title=` as an affordance's only explanation.** It renders on hover; a phone has none. The
  shell was a first-party offender in its own header (DEF-033).
- **An id is not a title.** An entity screen is named by the entity, falling back to its KIND — never
  to a uuid (DEF-034).
- **A loading state must say what is happening.** "Loading…" on blank paper for 25s reads as broken
  (DEF-038).
- **Absence measures as health, so instruments cannot see missing things.** The phone had no account
  menu, no space switcher and no sign-out, and every tap census scored those screens as passing
  (DEF-003). Geometry will never flag a control that does not exist; only a person looking will.

## 9. VERTICAL CLIPPING IS INVISIBLE TO EVERY METRIC HERE — DEF-037

Horizontal overflow got a per-element measure. **Vertical clipping did not, and there is nothing to
build one out of.** `overflowCount` scores a screen 0 while text is sliced through the middle of the
letterforms inside a fixed-height box.

**So the screenshot-eyeball pass is load-bearing, not ceremonial.** Every lane attaches the shots
that justify its own rows to its own task, and says in its report that it looked at them. **A lane
that closes a row on numbers alone has not closed it.**
