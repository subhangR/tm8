# Top bar → profile menu: Inbox and Copy link

**Owner's request, verbatim (2026-08-31):** "palatte inbox copy link and Tarakesh
profile section can you move inbox copy link to profile also when they hover
over copy link give information that they are sharing the space".

**Result:** the bar's right side is now exactly `/ palette · ⌘K` and the profile
menu. Inbox and Copy link are rows inside the profile menu's new utility group,
directly under the identity head and above Appearance.

Scope: `packages/tm8_ui_2.0/src` only. Nothing committed, built, deployed or
restarted.

---

## What changed

### `src/auth/AccountMenu.tsx` — the new utility group

Two new optional props, and the split between them is deliberate:

| prop | what it is | why it is not the other one |
|---|---|---|
| `onOpenInbox?: () => void` | the menu **owns** the Inbox row | the row has to keep the bell's D28 posture: with no handler it is still drawn, still focusable, still named, and carries the reason. A host-supplied row can never be in that state — a host that renders one has a handler by definition — so hosting Inbox would have silently deleted the refusal this move is supposed to preserve. |
| `utilityRows?: ReactNode` | **hosted** rows the menu cannot build | `CopyLinkControl` owns a URL codec, a clipboard refusal ladder and a manual-copy fallback. An auth component has no business knowing any of it. |

Both render inside one new `<div className="auth-menu__group auth-menu__group--utility">`,
placed above the appearance group. The group is drawn unconditionally, because
Inbox is always in it — "never hidden" stayed literal.

The Inbox row is the bell's markup translated into the existing row grammar (no
new row type invented): `auth-menu__row` / `auth-menu__row--live`,
`auth-menu__glyph`, `data-testid="open-inbox"`, `aria-label="Inbox"`,
`aria-disabled` + `title` when unwired, and the same
`<VectorIcon paths={VIEW_ART.inbox} size={15} />` art. Wired, it closes the
popover before navigating — matching its neighbours (Account & access tokens,
Sign out).

### `src/shell/SpaceTabBar.tsx` — both controls deleted

- Bell markup gone; `shareSlot` render gone.
- **Props removed, not left dangling:** `onOpenInbox` and `shareSlot`. A prop
  nothing passes is a control that cannot appear; a prop that is passed and
  dropped is worse.
- `VectorIcon` / `VIEW_ART` imports dropped (no longer used).
- Docblock: added revision 21, and rewrote the "THE BELL is Inbox's new door"
  paragraph rather than deleting it — the single-door ruling is unchanged, only
  the surviving door's address moved.

### `src/views/GateApp.tsx` — the one caller

`onOpenInbox` and the `CopyLinkControl` mount both moved from `SpaceTabBar` onto
`AccountMenu`. The copy-link mount keeps its existing "only with a Space"
condition and now carries `className="auth-menu__row auth-menu__row--live"` — the
host chose to hang the control in a menu, so the host says how it sits there.

### `src/share/CopyLinkControl.tsx` — hover text + a host seam

- New exported `SPACE_LINK_HINT`, applied as `title` on the button branch and on
  the manual-copy branch. (Not on the disabled-with-reason branch: there is no
  link, so there is nothing being shared to describe, and that branch already
  carries the true thing to say.)
- New optional `className` (host chrome for the root) and `hint` (override).
- `↗` got a `copy-link__glyph` class so it can align to the menu's 15px glyph
  column instead of being targeted by a fragile bare-`span` selector.

### CSS

`src/auth/auth.css` (all rules `.cv2-root `-prefixed, tokens only, no hex):

- `.auth-menu__group--utility` — `border-bottom: 1px solid var(--pn-line)`. The
  group that *introduced* the boundary owns the line, so the appearance group's
  markup is untouched; same 1px/`--pn-line` treatment as `--last`, so the menu
  has one boundary grammar and not two.
- `.auth-menu__glyph--art` — inline-flex centring for the drawn inbox mark. A
  modifier rather than a change to `.auth-menu__glyph`, so the ◐ / ⌗ / ↩ text
  rows (already centred correctly) do not pay for a row that moved.
- `.auth-menu__row .copy-link__glyph` — the 15px glyph column for the hosted row.
- `.auth-menu__row.copy-link--manual` (+ `:hover`) — the manual-copy fallback
  stays an instruction *above* a field, never a squeezed flex row inside a 280px
  menu, and does not take the live row's pointer/hover.

`src/shell/shell.css` — **superseded rules removed, and one of them was a real
trap:**

- `.shell-tabbar__bell` (grammar, hover lift, `aria-disabled` treatment,
  reduced-motion entry, focus-visible entry) — dead once the bell left.
- `.shell-tabbar .copy-link` / `.shell-tabbar .copy-link__button` — **not** dead.
  The account menu's popover is a descendant of `.shell-tabbar`, so those
  selectors would have kept matching the copy link at its new address, at higher
  specificity (0,3,0) than `.auth-menu__row` (0,2,0), and dressed a menu row as a
  32px bordered bar chip. A stale descendant selector is not inert once the
  element it names moves underneath it.
- The "ONE CONTROL GRAMMAR" comment block now says the cluster is two controls,
  not four, and why the rule is still stated for two.

`src/styles/tokens.css` was not touched.

---

## The hover wording, and why

```
Copies a link to this space, opened at this page. Anyone you send it to lands
exactly here and can see this space — its conversations, people and work — once
they sign in with an account that is already in this space. Share it only with
people you want inside.
```

Before this change the control had **no `title` at all**. The only thing hovering
taught anyone was the words "Copy link", which describes the clipboard, not the
consequence — someone copying a link to a task they were reading had no way to
know the address names the whole space around it. That is exactly the gap the
owner named.

Four rules held the wording:

1. **Name the space, not the screen.** "a link to this space, opened at this
   page" — the thing being handed over is a way in, not a page. This is the
   owner's actual point.
2. **Say what the recipient sees, concretely.** "its conversations, people and
   work". "Shares this space" on its own leaves a reader guessing whether that
   means one page or everything, which is the guess that gets a link pasted into
   the wrong window.
3. **Stay true — a link is not a grant.** Ruling R1=(a) is that recipients are
   already members; the codec authorizes nobody. Copy that promised access the
   link cannot give would be a lie in the one place a person is deciding who to
   trust, so the sentence ends "once they sign in with an account that is already
   in this space".
4. **Customer language.** No "entity", "target", "route", "codec", "URL" or
   "hash". The reader is a person deciding whether to paste this into a chat.

The tests assert the *claims* (1–4), not the sentence, plus one exact-string
check against the exported constant. The words may be edited; a version that
stops naming the space, stops saying what the recipient sees, or starts promising
access is a different — and in the last case false — message, and should fail.

---

## Tests: replaced, not deleted

**`src/shell/shell.test.tsx`** — the two bell tests ("the bell opens Inbox when a
host wires it", "the bell keeps the D28 posture without a host") were **claims
about the control, and both are still true** — just not of this file. They were
replaced with three assertions that are true here, each carrying a comment naming
what superseded it and where the old claims went:

- renders NO inbox bell, even for a host that still tries to wire `onOpenInbox`;
- renders NO share slot — a host handing the bar a share node gets nothing on
  screen, proving the prop removal is real and not merely unwired;
- the right cluster after the spacer is exactly `[palette, accountSlot]` — the
  owner's target shape, read off the DOM.

**`src/auth/gate.test.tsx`** — new `describe('the account menu's utility group')`
holding the migrated claims plus two more: the row opens Inbox *and closes the
menu*; it keeps the D28 posture unwired (announced / focusable / says why /
reachable by the name "Inbox"); hosted `utilityRows` land in the *same* group as
Inbox and that group precedes Appearance; the group is drawn with nothing hosted.

**`src/share/CopyLinkControl.test.tsx`** — three new tests: the hover claims on
the button, the same hint on the manual-copy fallback (the plain-http path most
viewers actually get must not be the one with no warning), and the host
`className` seam.

**`src/views/share-a-link.test.tsx`** — the end-to-end round trip. The claim
("offers a link at all", "copy in one app, open in another") is unchanged; the
*journey* changed, so the helper now opens the profile menu before reading the
field. One structural consequence, documented in the file: `AccountMenu` renders
nothing outside a gate (deliberately — a menu with no account and no sign-out
verb is enabled-inert), so a bare `GateApp` now has no account menu and therefore
no copy link. These mounts supply the gate context the shipped app always has
(`App.tsx` wraps `GateApp` in `AuthGate` unconditionally). Also added: a test that
the hover wording *survives the real mount*, which `CopyLinkControl.test.tsx`
cannot see.

---

## Test results actually observed

Run with `--maxWorkers=1`. No full-suite run was attempted.

| command | result | duration |
|---|---|---|
| `npx vitest run --maxWorkers=1 src/share/` | 1 file, **12 passed** | 2.68s |
| `npx vitest run --maxWorkers=1 src/auth/gate.test.tsx` | 1 file, **51 passed** | 13.07s |
| `npx vitest run --maxWorkers=1 src/shell/shell.test.tsx` | 1 file, **61 passed** | 4.36s |
| `npx vitest run --maxWorkers=1 src/views/share-a-link.test.tsx` | 1 file, **5 passed** | 11.19s |
| `npx vitest run --maxWorkers=1 src/shell/ src/auth/ src/share/` | 12 files, **269 passed** | 52.62s |
| `npx vitest run --maxWorkers=1 src/views/` | 56 files, **439 passed, 1 skipped** | 278.86s |
| `npx vitest run --maxWorkers=1 src/hex-ban src/no-op-handler-ban src/type-scale-ban src/fullwidth-plus-ban src/mobile-audit-css-parity` | 5 files, **12 passed** | 4.76s |
| `npx vitest run --maxWorkers=1 src/help/ src/board-v2/ src/mobile/` | 13 files, **216 passed** | 57.19s |
| re-run after the concurrent edit below: `src/shell/ src/auth/ src/share/ src/views/share-a-link.test.tsx` | 13 files, **274 passed** | 55.21s |
| `npx tsc -p tsconfig.json --noEmit` (twice, before and after) | **clean, no output** | — |

Nothing red, so no starvation call was needed. The only intermediate red was the
expected one: before `share-a-link.test.tsx` was updated it failed 2 of 4 (both
`waitFor` timeouts on `Share link`) — a genuine failure caused by the move, and
the reason the file needed the gate context, not a starvation artefact.

`views/` at 278.86s is a whole-directory wall-clock, not a single test's; no
individual test approached the 30,000ms timeout.

---

## Left undone / worth knowing

1. **The copy link is gone from un-gated mounts of `GateApp`.** In production
   this is invisible (`App.tsx` always wraps in `AuthGate`), but
   `src/mobile-audit-entry.tsx` mounts `GateApp` bare on purpose and will now
   show no account menu and no copy link on its desktop branch. Not fixed: that
   entry point exists to audit the phone shell, which keeps its own
   `CopyLinkControl` in the drawer and is untouched.
2. **The phone's copy link was not moved** — `views/MobileShell.tsx` mounts its
   own `CopyLinkControl` in `MobileDrawer`, which is a different arrangement of
   the same verbs and was not in scope. It does inherit the new hover text (the
   hint defaults on, no edit needed there).
3. **CSS was not visually verified.** The gate runs `css: false`, so a green run
   cannot see any of the stylesheet changes; they are asserted only as source. No
   build, no browser check — per instruction. The three seam rules
   (`copy-link--manual` grid override, glyph column, group separator) are the
   ones a pixel pass should look at first, in both themes and at the menu's
   `min(280px, 100vw - 24px)` width.
4. **`ACCOUNT_MENU` in `auth/specimen.ts` was not extended** with an Inbox label.
   That file is extracted oracle copy; the row's label is inlined instead rather
   than putting product copy into a specimen.
5. **A sibling lane edited this worktree mid-task.** At 01:43, after my
   `auth.css` edit, another agent's sweep landed a `--pn-serif` → `--pn-prose`
   token rename in `src/styles/tokens.css` and rewrote the `font-family`
   references across many stylesheets including `src/auth/auth.css`. So
   `git status` shows `tokens.css` modified — **that is not mine; I never opened
   it for writing.** My five new `auth.css` rules survived intact (verified by
   grep), and the whole gate was re-run afterwards (row 9 above) plus `tsc`,
   both green. Worth knowing if this diff is reviewed as one changeset: the
   `tokens.css` and `--pn-prose` hunks belong to that other lane.
6. **No count on the Inbox row**, exactly as the bell had none. There is still no
   honest per-viewer unseen read in the chrome, and a fabricated zero would
   assert "nothing wants you" about a fact nobody measured.
