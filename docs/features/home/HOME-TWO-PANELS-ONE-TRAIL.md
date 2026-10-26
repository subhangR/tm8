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
- **U11 — Esc steps the cursor back.** At the root it does nothing (U14, §3.7).
- **U12 → D4** — how the hop marks are addressed.

Ruled in the #653 review:

- **U13 — On Home, the cursor's own entry survives the pin filter.** A hop onto
  an entity pinned in Work reaches the address. Home only (§3.2).
- **U14 — Esc at the root does nothing** (§3.7).
- **U15 — "Open in Workspace →" moves into the Trail strip**, acting on the
  cursor's entity (§3.6).

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

**U13 — on Home, the entry the cursor stands on is exempt from that filter.**
The held entry is `pc`'s, or the top's when `pc` is omitted. It is resolved
from the deduped `p` BEFORE the filter; resolved after, the entry is already
gone and the exemption is dead code. Every other pinned entry is still
stripped. Off Home nothing is held, so Work routes normalize exactly as they
did on main: `codec.test.ts` checks 32 routes against hashes printed by main's
codec, "U13 leaves every non-Home route exactly as main normalizes it". The
gate is on the ROUTE's view, not the cursor, because the cursor rides the wire
onto Work (`navigate` writes `view` alone).

```
stack [a,b,c], cursor on b, pin a → normalize strips a → [b,c]
  index: 1 → c.  Wrong entity, correct-looking chrome. Nothing detects it.
  id:    b → 0.  Right entity. The shift is ABSORBED, not survived.

stack [a,b,c], cursor on b, pin b → on Home b is held → [a,b,c]
  id:    b → 1.  Right entity; nothing was lost, so nothing is announced.

stack [a,b], a hop onto x (pinned in Work) → [a,b,x], cursor at the top
  wire carries no pc → null holds the top → x survives → a reload lands on x.
  This is the case U13 exists for; before it, the hop never reached `p`.

pc=zz, and zz is not on p
  id:    absent → clamp to top + the 'cursor' drop notice. DETECTABLE.
```

The held id is then in `pin` AND `p` at once. That is never two panels: Home
renders the Trail and never reads `pinned`, and Work renders
`[...pinned, top]` through `selectPanelIds`, which now dedupes (§4).

*History.* The first cut checked `pc` only against the raw `p`, so a pinned
`pc` clamped to the top with nothing said. The review then made `parse` report
it as a `'cursor'` drop, because `normalize` has no drop channel. U13 dissolved
the case instead: a pinned `pc` is a real position, so `parse`'s rule came out
and its test inverted (`codec.test.ts`, "a pc naming an entity that is also
PINNED stays on the Trail").

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
The crumbs earn their place only at length ≥ 2.

**The door into Work lives at the strip's far end (U15).** "Open in Workspace
→" sat on region C's header. It now acts on `stack[cursor]`, the entity the
panel below is showing, and it is there at length 1, where the strip carries
it alone. `HomeView`'s `onOpenInWorkspace` feeds it, and `GateApp`'s handler
(switch to Work, `push` the id) is unchanged.

### 3.7 Esc steps back, and never truncates (D7, corrected by U14)

`Esc` = `trailBack()`. At cursor 0 it does **nothing**, and does not claim the
key. Esc is the one gesture people press without looking, so it is the one
that must not lose the forward half. Pickers and sheets still consume Esc
first (`useDismissable`) — unchanged. Returning B to the conversation is the
entity panel's explicit close (`clearStack`), not a keypress.

**Corrected in place (U14, #653 review).** D7 as first written also said "at
cursor 0 it returns the centre to the conversation". That half was wrong:
clearing at the root discards every hop ahead of the cursor, which is exactly
what D7's own reason — Esc must not lose the forward half — forbids. The
letter and the reason disagreed; the reason wins.

## 4. What retired, what survived

**Retired:** `PanelState.right` and the `r` param · `openRight` / `rightTo` /
`popRight` / `closeRight` · `NavState.right` · `'right'` in `DropClass` and
`DROP_CLASS_COPY` · HomeView's region-C mount, its `PanelResizer` and
`ASIDE_MIN` / `ASIDE_DEFAULT` / `ASIDE_CHROME` · `HomePage`'s `aside` slot and
`data-aside` · the `.hp-aside*` rules in `home-page.css` · R6's promote path ·
`views/home-tree.ts` · R7's "breadcrumbs on both panels".

**Survived, moved:** "Open in Workspace →", from region C's header into the
Trail strip (U15, §3.6).

**Survived untouched:** Work and `WorkspaceView` · `PanelStack` · pinning ·
`LiveSessionBar` · `pinned`, `session`, `tabs`, `contentSurface` · `push` and
every other Work verb · `selectStackTop`.

**Changed under Work, deliberately (#653 review).** U13 lets one id sit in
`pin` and at the top of `p` together. On main the render list and its count
were each written out separately as `[...pinned, top]`, so that id would have
been drawn twice and counted twice. The list is now deduped, and the count is
DERIVED from it, at all five sites:
- `navStore.selectPanelIds` / `selectVisibleCount`;
- `shell/nav-port.ts`'s copies of the same pair;
- `shell/geometry.ts`'s `panelSlots`.

`panelSlots` is the one that carries weight. It is the V that `cMin` reads in
`cMinFor`, `admitPin` and the demotion loop. The two `selectVisibleCount`s
have no production caller.

Off the overlap the change is a no-op: `geometry.test.ts` sweeps every ordered
pin/stack pair drawn from a pool of five ids and checks the old count wherever
the top is not pinned. On the overlap, the old count reserved a column for an
entity drawn once. That made `admitPin` refuse pins that fit, and made the
demotion loop demote early. Both now reserve what they draw.

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

- **FIXED by U13 — a hop onto an entity PINNED in Work no longer desyncs the
  store from the address.** The review first proposed accepting it: `normalize`
  stripped the hop from `p`, so a reload landed one crumb back. On Home the
  cursor's entry now survives the filter (§3.2). "Hosts one id twice", the
  objection to exempting it, is answered in two places. Home never reads
  `pinned`. Work's render list dedupes (§4).
- **Residual, by the gate: a Trail reloaded while on WORK.** U13 is Home's.
  Say the cursor stands on a pinned entity and the viewer switches to Work. The
  store keeps the Trail, so returning to Home in the same session loses
  nothing. But Work's address is normalized by Work's law, which strips that
  entity from `p`. A reload or shared link taken on Work therefore comes back
  to Home one crumb short, with no notice, because `normalize` has no drop
  channel. This is the pre-U13 behaviour, now confined to Work's addresses.
- **RESOLVED by U15 — Home's door into Work.** "Open in Workspace →" had been
  left with no call site when region C retired. It now lives in the Trail
  strip (§3.6).
