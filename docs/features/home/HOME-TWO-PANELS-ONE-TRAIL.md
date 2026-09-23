# Home — two panels, one Trail

**Status:** ruled and implemented · task `01a0c864-41c9-75d6-a64d-8dbb4ba44a22` · 2026-09-22
**Supersedes:** `UNIFIED-HOME-DESIGN.md` **R6** (centre vs right) and **R7** (breadcrumbs on both panels)
**Scope:** `packages/tm8-ui` — Home only. **Work is not touched.**

## 1. What changed

Home had three regions. Opening an entity in B and picking a connection opened
a THIRD panel (region C, the route's `r` trail), while a click inside B's own
hierarchy pushed onto B's trail instead — two gestures, two destinations,
decided by an ancestor walk (`views/home-tree.ts`'s `inTreeOf`).

Home is now two:

```
[rail][ A · list — the root chooser ][ B · detail — ONE Trail ]
```

A connection hop and a hierarchy hop both land in B and both extend the same
**Trail**. Region C is gone.

**Glossary.** The walk is a **Trail** — the folder-path-like sequence
`Project › Task › PR`. One step is a **hop**. One rendered entry is a
**crumb**. Where you stand in it is the **cursor**.

## 2. The rulings (Subhang, 2026-09-22)

- **U1 — Work stays as it is.** No menu, `WorkspaceView`, `PanelStack`,
  pinning or live-session-bar change. Home only.
- **U2 — Home is two panels.** Region C retires.
- **U3 — Marked hops.** `›` for a hierarchy step, `→` for a connection step.
- **U4 — The word is "Trail"**, in code, UI and docs.
- **U5 — Cursor, keep forward.** The Trail stays whole; a cursor moves along
  it. It truncates only when you navigate somewhere **new** from a mid-point.
- **U6 — `r` retires everywhere.**
- **U7 — Column A stays put** when the Trail walks off its population.
- **U8 — `p` carries the whole Trail; `pc` carries the cursor.**
- **U9 — A long Trail collapses its middle to `…`**, which opens a jump menu.
- **U10 — Picking a row in column A restarts the Trail clean.**
- **U11 — Esc steps the cursor back.**
- **U12 → D4** — how the hop marks are addressed.

## 3. How it is built

### 3.1 One array, one index (D1)

`navStore.stack` is the whole Trail and `navStore.cursor` is an index into it.
**Home renders `stack[cursor]`, not `stack[stack.length - 1]`** — that single
substitution is the heart of the change. Not a back/forward *pair* of arrays:
two lists can disagree about the same walk, and one array with an index cannot
contradict itself.

**Home has its OWN verbs; `push` is untouched.** The design's verb table
rewrote `push` to truncate the forward half and append without deduping, but
`push` is Work's verb: its dedupe-and-raise is the single-host law (WLT §5.2c),
it is declared in `shell/nav-port.ts`'s `NavPort` contract, and
`WorkspaceView`/`GateApp` call it in sixteen places. U1 says Work stays as it
is, so the Trail got its own verbs.

| verb | behaviour |
|---|---|
| `openCenter(id)` | roots the Trail: `stack = [id]`, `cursor = 0` (U10) |
| `trailPush(id)` | a hop. On an id ALREADY on the Trail it **seeks** (see below). Anywhere new from mid-Trail discards the forward half (U5) — the only thing that shortens it |
| `cursorTo(id)` | crumb click / jump menu: `cursor = indexOf(id)`. The Trail is untouched |
| `trailBack()` / `trailForward()` | `cursor ∓ 1`, clamped |
| `clearStack()` | back to the conversation |
| `push`, `pop`, `close`, `pin`, … | Work's, unchanged — each parks the cursor at the top |

**A REVISIT SEEKS, it does not append** *(correction to D1, ruled by the user
2026-09-22)*. Walking `a → b → a` leaves `[a, b]` with the cursor back on `a`
and `b` still ahead of you. Two reasons: `normalize` dedupes `p`, so a repeated
crumb would be collapsed by the very next URL write and the Trail would
disagree with its own address; and a Trail that can repeat is a LOG, while the
thing this screen is for is a PATH.

### 3.2 `pc` — the cursor's address (D2, as corrected)

`p` carries the full Trail bottom→top, unchanged. `pc` carries the cursor.
**Omitted ⇒ cursor at the top**, so every link that exists today parses
identically and lands exactly where it lands today. That compatibility
guarantee has its own test (`codec.test.ts`, "a TODAY-SHAPED link with no pc").

**Index in the store, ID on the wire.** D2 said an index, on the grounds that
ids repeat and `p=a,b,a` could not say which `a` you stood on. The no-repeats
ruling above removed that premise, and the pin cross-filter supplies a better
one in the other direction: `normalize` strips from `stack` any id that is
also pinned, and pins survive a Work→Home switch, so the Trail can lose an
entry under the cursor's feet.

```
stack [a,b,c], cursor on b, pin a → normalize strips a → [b,c]
  index: 1 → c.  Wrong entity, correct-looking chrome. Nothing detects it.
  id:    b → 0.  Right entity. The shift is ABSORBED, not survived.

stack [a,b,c], cursor on b, pin b → normalize strips b → [a,c]
  id:    absent → clamp to top + the 'cursor' drop notice. DETECTABLE.

stack [a,b,c], cursor on c (the top), pin c → [a,b]
  wire carried null → null still resolves → the cursor lands on b, the new
  top, SILENTLY. Correct: null is a canonical position, not an address that
  failed to resolve, so nothing dangled and nothing is announced. A notice
  here would fire on every ordinary top-of-trail pin.
```

The notice in the second case is raised by `parse`, not `normalize`: the pin
cross-filter runs in `normalize`, which returns a route and has no drop channel
at all, so `parse` — the last tier that can still report — treats a `pc` that
is also in `pin` as dangling. (The first cut checked `pc` only against the raw
`p` and clamped this case silently; caught in review, pinned by `codec.test.ts`
"a pc naming an entity that is also PINNED".)

An index is still what the store holds — `trailBack`/`trailForward` and the
render move along an array — and the id/index conversion happens at the one
seam that needs it: `hydrate` resolves id→index against the already-normalized
stack, `routeOf` maps index→id and emits `null` at the top.

`'cursor'` is its own **drop class** ("your place in the trail"), not folded
into `'stack'`: a notice that says open panels were dropped when only the
position was lost names the wrong class (R4-7). `pc` rides in **`p`'s own drop
tier**, so the 2048-cap machinery can never leave a `pc` addressing a `p` that
is no longer there.

### 3.3 Back and Forward walk the Trail (D3)

`openCenter`, `trailPush`, `cursorTo`, `trailBack` and `trailForward` all push
history. Because the whole arrangement lives in the URL, browser **Back moves
the cursor one hop**, and a shared link reproduces both the Trail and the
position in it.

### 3.4 Hop marks are DERIVED, not stored (D4)

`p`'s grammar is unchanged. At render, `HomeTrail` compares one step: if
`parentOf(stack[i]) === stack[i-1]` that hop is hierarchy (`›`), otherwise
connection (`→`).

*Rejected — a parallel `pk=hhcch` marks param:* it must stay exactly as long as
`p`, and every verb that edits one must edit the other. A drift class that does
not exist today, bought for a glyph. *Rejected — prefixing marks into `p`:*
changes the grammar every existing link and the codec's parser depend on.

Two consequences, stated so nobody "fixes" them later:

1. **While the parent chain is not yet in the detail cache the separator
   renders neutral (`›`) rather than guessing.** It never flips from wrong to
   right; it fills in from unknown to known — the same posture as the Trail's
   title fallback, which shows the kind label rather than a raw id.
2. **The mark describes the data, not the gesture.** Reach a child *through*
   the Connections tab and the crumb still reads `›`, because it *is* its
   parent. Unlike a stored gesture, that survives a reload.

### 3.5 Column A holds still (D5)

A keeps its population and simply carries **no selected row** while
`stack[cursor]` is off-population. Move the cursor back onto something A lists
and the row highlights again. A is where you came from; the Trail is where you
are.

This deletes R6's promote path — there is no C to promote from — **and with it
the only caller of `inTreeOf` on the Home path.** That guard existed to stop
the centre silently re-rooting. Auditing what it guarded rather than what it
measured: with one Trail and a restart that can only come from column A (U10),
the centre has no other way to re-root, so the hazard retires with the branch
rather than being left uncovered. D4 needs only a single-step parent compare,
so `views/home-tree.ts` is deleted with its call site.

### 3.6 The strip collapses its middle (D6)

`root … parent › current`. An `…` stands exactly where hops are hidden and
opens a menu listing **every** hop in order, each with its mark, the cursor's
entry marked current. **Hops ahead of the cursor are listed too, dimmed** —
that is where "keep forward" stops being merely true and becomes visible. A
Trail walked back to its root therefore shows `current …`: that trailing
ellipsis is the only thing on the screen saying there is still something ahead.
The strip still earns its row only at length ≥ 2.

### 3.7 Esc steps back, and never truncates (D7)

`Esc` = `trailBack()`. At cursor 0 it returns the centre to the conversation
(already mounted-but-hidden, prior D8). Esc is the one gesture people press
without looking, so it is the one that must not lose the forward half. Pickers
and sheets still consume Esc first (`useDismissable`) — unchanged.

At cursor 0 there is nowhere further back on the Trail, so Esc clears the
centre (`clearStack`) and the forward half goes with it — D7 as ruled. It is
one keystroke from recovery, not lost: `clearStack` writes a history PUSH, so
browser Back restores the whole Trail, forward half included. Making Esc-at-0
inert instead would be a change to D7, not a fix to it.

## 4. What retired, what survived

**Retired:** `PanelState.right` and the `r` param · `openRight` / `rightTo` /
`popRight` / `closeRight` · `NavState.right` · `'right'` in `DropClass` and
`DROP_CLASS_COPY` · HomeView's region-C mount, its `PanelResizer` and
`ASIDE_MIN` / `ASIDE_DEFAULT` / `ASIDE_CHROME` · `HomePage`'s `aside` slot and
`data-aside` · the `.hp-aside*` rules in `home-page.css` · R6's promote path ·
`views/home-tree.ts` · R7's "breadcrumbs on both panels".

**Survived untouched:** Work and `WorkspaceView` · `PanelStack` · pinning ·
`LiveSessionBar` · `pinned`, `session`, `tabs`, `contentSurface` · `push` and
every other Work verb · `selectStackTop`.

**On U6 being safe.** Retiring `r` *everywhere* reads like it should disturb
Work, and it does not: `HomeView` is the only thing that ever rendered the `r`
trail. Work's `layout.right` is grid geometry and `useSidePanelKinds`'
`panels.right` is a stored side-panel *kind* — both are name collisions, not
the `r` trail.

## 5. Settled open items

- **O1 — old `r=` links FOLD, they do not drop.** A hydrating route carrying
  `r` appends `r`'s top entry onto the end of `p`, and the rest of `r` is
  discarded silently. Because the fold lands that entity at the top and an
  absent `pc` means the top, the link opens on exactly the entity it named.
  When that entity is ALREADY on `p` below its top it cannot be appended (the
  Trail holds each entity once), so the fold SEEKS — the cursor goes to it, the
  same rule as a live revisit. An explicit `pc` outranks the fold.
  The alternative was dropping it with a notice; folding was chosen because
  the notice tells the viewer something was lost rather than not losing it.
  **Open to reversal on review.**
- **O2 — explicit ←/→ controls beside the strip: out of scope.** Crumbs, Esc,
  browser Back and the jump menu cover the walk.

## 6. Known edges and open questions (from the #653 review)

- **A hop onto an entity PINNED in Work desyncs the store from the address —
  accepted.** `trailPush`/`openCenter` put it on the Trail and Home renders
  it, but `normalize`'s pin cross-filter strips it from `p`, so the address
  never carries the hop and a reload lands one crumb back (or on the empty
  centre). Refusing the hop fails a legitimate click for a reason the viewer
  cannot see; unpinning lets Home mutate Work's pins (U1); exempting `p` from
  the filter hosts one id twice. Documented at the divergence in `trailPush`.
  Needs an entity pinned in Work AND reached from Home in the same session.
- **OPEN — Home's per-entity door into Work.** "Open in Workspace →" lived on
  region C's header and retired with it; `HomeView`'s `onOpenInWorkspace`
  prop survives with no call site while `GateApp` still wires a working
  handler. §4 does not list it as retired. Awaiting a ruling (re-home it into
  the Trail strip, or retire the prop and its handler and list it in §4).
